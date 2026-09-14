import type { FailureReport, ParsedException } from "../contracts/failures.js";
import type {
  EvidenceFact,
  EvidenceObligationSpec,
  EvidenceRetrievalAdapter,
  EvidenceRetrievalRequest,
  EvidenceSufficiencyResult,
  ObligationBuildInput,
  ObligationKind
} from "../contracts/obligations.js";
import type {
  EvidenceObligation,
  PolicyRule,
  ProducerMetadata
} from "../contracts/providers.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import { deterministicUuid } from "../core/hash.js";
import { sha256Base64Url } from "../core/hash.js";
import { failure, success, type Result } from "../core/result.js";
import type { ArtifactSnapshot, EvidenceSpan } from "../contracts/types.js";
import { typedFailureParsers } from "../parsers/failures.js";

const MAX_RETRIEVAL_REQUESTS = 8;
const MAX_RETRIEVAL_BYTES = 64 * 1024;

function producer(
  producerId: string,
  kind: ProducerMetadata["kind"],
  version: string,
  contract: unknown
): ProducerMetadata {
  return {
    producerId,
    kind,
    version,
    digest: canonicalJsonDigest({ producerId, kind, version, contract })
  };
}

function obligationId(
  kind: ObligationKind,
  key: string,
  description: string
): string {
  return deterministicUuid(`${kind}:${key}:${description}`);
}

function spec(
  kind: ObligationKind,
  key: string,
  description: string,
  options: Omit<
    EvidenceObligationSpec,
    "obligationId" | "kind" | "key" | "description"
  > = { required: true }
): EvidenceObligationSpec {
  return {
    obligationId: obligationId(kind, key, description),
    kind,
    key,
    description,
    ...options
  };
}

function flattenExceptions(
  exceptions: readonly ParsedException[]
): readonly ParsedException[] {
  return exceptions.flatMap((exception) => [
    exception,
    ...flattenExceptions(exception.causes)
  ]);
}

export function buildFailureObligationSpecs(
  input: ObligationBuildInput
): readonly EvidenceObligationSpec[] {
  const specs: EvidenceObligationSpec[] = [];
  for (const report of input.reports) {
    if (!report.recognized && report.fallbackRanges.length > 0) {
      specs.push(
        spec(
          "failure-block",
          `${report.artifactId}:typed-failure`,
          "A typed failure block is required for the unrecognized diagnostic",
          {
            required: true,
            retrieval: {
              adapterId: "evidence-read",
              artifactId: report.artifactId,
              maxBytes: 16 * 1024,
              purpose: "Retrieve a bounded detailed failure block"
            }
          }
        )
      );
    }
    for (const test of report.tests) {
      const base = `${report.artifactId}:${test.testName}`;
      specs.push(
        spec("failure-block", base, `Failure block for ${test.testName}`)
      );
      specs.push(
        spec(
          "expected-value",
          `${base}:expected`,
          `Expected value for ${test.testName}`
        )
      );
      specs.push(
        spec(
          "actual-value",
          `${base}:actual`,
          `Actual value for ${test.testName}`
        )
      );
      if (test.location !== undefined) {
        specs.push(
          spec(
            "referenced-source",
            `${test.location.path}:${test.location.line}`,
            `Referenced source for ${test.testName}`,
            {
              required: true,
              retrieval: {
                adapterId: "source-read",
                maxBytes: 12 * 1024,
                purpose: `Retrieve exact source around ${test.location.path}:${test.location.line}`
              }
            }
          )
        );
      }
    }
    for (const exception of flattenExceptions(report.exceptions)) {
      const key = `${report.artifactId}:${exception.type}:${exception.startByte}`;
      specs.push(
        spec(
          "failure-block",
          key,
          `${exception.type} exception and complete cause context`
        )
      );
      for (const frame of exception.frames) {
        specs.push(
          spec(
            "referenced-source",
            `${frame.location.path}:${frame.location.line}`,
            `Referenced source for ${exception.type}`,
            {
              required: true,
              retrieval: {
                adapterId: "source-read",
                maxBytes: 12 * 1024,
                purpose: `Retrieve exact source around ${frame.location.path}:${frame.location.line}`
              }
            }
          )
        );
      }
    }
    if (report.commands.length > 0 || report.exitCode !== undefined) {
      specs.push(
        spec(
          "command-exit",
          `${report.artifactId}:command-exit`,
          "Command and authoritative exit status"
        )
      );
    }
    if (report.environment.length > 0) {
      specs.push(
        spec(
          "runtime",
          `${report.artifactId}:runtime`,
          "Runtime and environment facts"
        )
      );
    }
  }
  if (
    input.evidence.some((evidence) => evidence.kind === "final-summary")
  ) {
    specs.push(
      spec("final-summary", "final-summary", "Final diagnostic summary")
    );
  }
  return [...new Map(specs.map((item) => [item.obligationId, item])).values()];
}

export function factsFromFailureReports(
  reports: readonly FailureReport[],
  specs: readonly EvidenceObligationSpec[],
  evidence: readonly EvidenceSpan[]
): readonly EvidenceFact[] {
  const facts: EvidenceFact[] = [];
  const addFact = (input: {
    kind: ObligationKind;
    key: string;
    value: string;
    artifactId: string;
    startByte: number;
    endByte: number;
    allowedEvidenceKinds: readonly EvidenceSpan["kind"][];
  }): void => {
    const obligation = specs.find(
      (item) => item.kind === input.kind && item.key === input.key
    );
    if (obligation === undefined) return;
    const matchingEvidence = evidence.filter(
      (item) =>
        item.artifactId === input.artifactId &&
        item.startByte < input.endByte &&
        input.startByte < item.endByte &&
        input.allowedEvidenceKinds.includes(item.kind)
    );
    if (matchingEvidence.length === 0) return;
    const source = matchingEvidence[0] as EvidenceSpan;
    facts.push(
      createEvidenceFact({
        obligationId: obligation.obligationId,
        kind: input.kind,
        key: input.key,
        value: input.value,
        evidenceIds: matchingEvidence.map((item) => item.evidenceId),
        artifactId: source.artifactId,
        startByte: source.startByte,
        endByte: source.endByte,
        sha256: source.sha256,
        byteLength: source.endByte - source.startByte
        ,
        origin: "detector-evidence"
      })
    );
  };
  for (const report of reports) {
    for (const test of report.tests) {
      const base = `${report.artifactId}:${test.testName}`;
      addFact({
        kind: "failure-block",
        key: base,
        value: test.testName,
        artifactId: report.artifactId,
        startByte: test.startByte,
        endByte: test.endByte,
        allowedEvidenceKinds: [
          "failing-test",
          "assertion-block",
          "expected-value",
          "actual-value"
        ]
      });
      if (test.expected !== undefined) {
        addFact({
          kind: "expected-value",
          key: `${base}:expected`,
          value: test.expected,
          artifactId: report.artifactId,
          startByte: test.startByte,
          endByte: test.endByte,
          allowedEvidenceKinds: ["expected-value", "assertion-block"]
        });
      }
      if (test.actual !== undefined) {
        addFact({
          kind: "actual-value",
          key: `${base}:actual`,
          value: test.actual,
          artifactId: report.artifactId,
          startByte: test.startByte,
          endByte: test.endByte,
          allowedEvidenceKinds: ["actual-value", "assertion-block"]
        });
      }
    }
    for (const exception of flattenExceptions(report.exceptions)) {
      addFact({
        kind: "failure-block",
        key: `${report.artifactId}:${exception.type}:${exception.startByte}`,
        value: `${exception.type}: ${exception.message}`,
        artifactId: report.artifactId,
        startByte: exception.startByte,
        endByte: exception.endByte,
        allowedEvidenceKinds: [
          "exception",
          "exception-chain",
          "stack-frame"
        ]
      });
    }
    if (report.commands.length > 0 || report.exitCode !== undefined) {
      const commandEvidence = evidence.filter(
        (item) =>
        item.artifactId === report.artifactId &&
        ["command", "exit-code"].includes(item.kind)
      );
      if (commandEvidence.length > 0) {
        const first = commandEvidence[0] as EvidenceSpan;
        const obligation = specs.find(
        (item) =>
          item.kind === "command-exit" &&
          item.key === `${report.artifactId}:command-exit`
        );
        if (obligation !== undefined) facts.push(createEvidenceFact({
        obligationId: obligation.obligationId,
        kind: "command-exit",
        key: `${report.artifactId}:command-exit`,
        value: `${report.commands.at(-1)?.command ?? "unknown"}:${
          report.exitCode ?? "unknown"
        }`,
        evidenceIds: commandEvidence.map((item) => item.evidenceId),
        artifactId: report.artifactId,
        startByte: first.startByte,
        endByte: first.endByte,
        sha256: first.sha256,
        byteLength: first.endByte - first.startByte
        ,
        origin: "detector-evidence"
        }));
      }
    }
    if (report.environment.length > 0) {
      const runtimeEvidence = evidence.filter(
        (item) =>
        item.artifactId === report.artifactId &&
        item.kind === "version"
      );
      const obligation = specs.find(
        (item) =>
        item.kind === "runtime" &&
        item.key === `${report.artifactId}:runtime`
      );
      if (runtimeEvidence.length > 0 && obligation !== undefined) {
        const first = runtimeEvidence[0] as EvidenceSpan;
        facts.push(createEvidenceFact({
        obligationId: obligation.obligationId,
        kind: "runtime",
        key: `${report.artifactId}:runtime`,
        value: report.environment
        .map((fact) => `${fact.key}=${fact.value}`)
        .join(";"),
        evidenceIds: runtimeEvidence.map((item) => item.evidenceId),
        artifactId: report.artifactId,
        startByte: first.startByte,
        endByte: first.endByte,
        sha256: first.sha256,
        byteLength: first.endByte - first.startByte
        ,
        origin: "detector-evidence"
        }));
      }
    }
  }
  const summarySpec = specs.find(
    (item) => item.kind === "final-summary"
  );
  const summaries = evidence.filter(
    (item) => item.kind === "final-summary"
  );
  if (summarySpec !== undefined && summaries.length > 0) {
    const first = summaries[0] as EvidenceSpan;
    facts.push(createEvidenceFact({
      obligationId: summarySpec.obligationId,
      kind: "final-summary",
      key: summarySpec.key,
      value: summaries.map((item) => item.textPreview).join("\n"),
      evidenceIds: summaries.map((item) => item.evidenceId),
      artifactId: first.artifactId,
      startByte: first.startByte,
      endByte: first.endByte,
      sha256: first.sha256,
      byteLength: first.endByte - first.startByte
      ,
      origin: "detector-evidence"
    }));
  }
  return facts;
}

export function createEvidenceFact(input: Omit<EvidenceFact, "factId" | "validationDigest">): EvidenceFact {
  const factId = deterministicUuid(
    `${input.obligationId}:${input.kind}:${input.key}:${input.artifactId}:${input.startByte}:${input.endByte}:${input.sha256}:${input.value}`
  );
  const unsigned = { factId, ...input };
  return { ...unsigned, validationDigest: canonicalJsonDigest(unsigned) };
}

function validFact(
  fact: EvidenceFact,
  spec: EvidenceObligationSpec,
  evidence: readonly EvidenceSpan[]
): boolean {
  const { validationDigest, ...unsigned } = fact;
  return (
    validationDigest === canonicalJsonDigest(unsigned) &&
    fact.obligationId === spec.obligationId &&
    fact.kind === spec.kind &&
    fact.key === spec.key &&
    fact.evidenceIds.length > 0 &&
    fact.byteLength === fact.endByte - fact.startByte &&
    fact.byteLength >= 0 &&
    /^[A-Za-z0-9_-]{43}$/.test(fact.sha256) &&
    (fact.origin === "bounded-retrieval" ||
      (fact.evidenceIds.every((evidenceId) =>
        evidence.some((span) => span.evidenceId === evidenceId)
      ) &&
        evidence.some(
          (span) =>
            fact.evidenceIds.includes(span.evidenceId) &&
            span.artifactId === fact.artifactId &&
            span.startByte === fact.startByte &&
            span.endByte === fact.endByte &&
            span.sha256 === fact.sha256
        )))
  );
}

export class EvidenceObligationEvaluator {
  readonly metadata = producer(
    "builtin.cq03-cq06.obligation-evaluator",
    "feature-provider",
    "1.0.0",
    ["satisfied", "missing", "ambiguous", "contradicted", "stale"]
  );

  evaluate(
    specs: readonly EvidenceObligationSpec[],
    facts: readonly EvidenceFact[],
    now = new Date(),
    evidence: readonly EvidenceSpan[] = []
  ): EvidenceSufficiencyResult {
    const obligations: EvidenceObligation[] = specs.map((item) => {
      const matches = facts.filter(
        (fact) => validFact(fact, item, evidence)
      );
      const values = [...new Set(matches.map((fact) => fact.value))];
      const freshnessMs = item.freshnessMs;
      let status: EvidenceObligation["status"];
      const reasons: string[] = [];
      if (matches.length === 0) {
        status = "missing";
        reasons.push("No matching evidence fact was available");
      } else if (matches.some((fact) => fact.contradicts === true)) {
        status = "contradicted";
        reasons.push("At least one evidence fact explicitly contradicts the obligation");
      } else if (
        item.expectedValue !== undefined &&
        values.some((value) => value !== item.expectedValue)
      ) {
        status = "contradicted";
        reasons.push("Observed value contradicts the expected value");
      } else if (values.length > 1) {
        status = "ambiguous";
        reasons.push("Multiple distinct evidence values were observed");
      } else if (
        freshnessMs !== undefined &&
        matches.every((fact) => {
          if (fact.observedAt === undefined) return true;
          return now.getTime() - Date.parse(fact.observedAt) > freshnessMs;
        })
      ) {
        status = "stale";
        reasons.push("Available evidence is outside the freshness window");
      } else {
        status = "satisfied";
        reasons.push("Required evidence is present and consistent");
      }
      return {
        obligationId: item.obligationId,
        kind: item.kind,
        key: item.key,
        description: item.description,
        required: item.required,
        status,
        evidenceIds: matches.flatMap((fact) => fact.evidenceIds),
        reasons,
        producer: this.metadata
      };
    });
    const unresolved = obligations.filter(
      (obligation) =>
        obligation.required && obligation.status !== "satisfied"
    );
    const unresolvedIds = new Set(
      unresolved.map((obligation) => obligation.obligationId)
    );
    const retrievalRequests = specs
      .filter(
        (item) =>
          item.required &&
          unresolvedIds.has(item.obligationId) &&
          item.retrieval !== undefined
      )
      .slice(0, MAX_RETRIEVAL_REQUESTS)
      .map((item) => ({
        obligationId: item.obligationId,
        ...(item.retrieval as Omit<
          EvidenceRetrievalRequest,
          "obligationId"
        >)
      }));
    return {
      obligations,
      decision:
        unresolved.length === 0 ? "ready" : "gather-more-evidence",
      retrievalRequests,
      producer: this.metadata
    };
  }
}

export class GatherMoreEvidencePolicy
  implements
    PolicyRule<EvidenceSufficiencyResult, EvidenceSufficiencyResult>
{
  readonly metadata = producer(
    "builtin.cq03-cq06.gather-policy",
    "policy-rule",
    "1.0.0",
    ["gather-precedes-delivery", "bounded-requests", "deterministic-status-order"]
  );

  decide(
    input: EvidenceSufficiencyResult
  ): Result<{
    action: "accept" | "gather";
    priority: number;
    value: EvidenceSufficiencyResult;
    reasons: readonly string[];
    producer: ProducerMetadata;
  }> {
    const unresolved = input.obligations.filter(
      (obligation) =>
        obligation.required && obligation.status !== "satisfied"
    );
    return success({
      action: unresolved.length === 0 ? "accept" : "gather",
      priority: unresolved.length === 0 ? 10 : 1000,
      value: input,
      reasons:
        unresolved.length === 0
          ? ["All evidence obligations are satisfied"]
          : unresolved.map(
              (obligation) =>
                `${obligation.status}: ${obligation.description}`
            ),
      producer: this.metadata
    });
  }
}

export async function executeBoundedRetrieval(
  requests: readonly EvidenceRetrievalRequest[],
  adapters: ReadonlyMap<string, EvidenceRetrievalAdapter>
): Promise<Result<readonly EvidenceFact[]>> {
  if (requests.length > MAX_RETRIEVAL_REQUESTS) {
    return failure("LIMIT_EXCEEDED", "Too many evidence retrieval requests", {
      requests: requests.length,
      limit: MAX_RETRIEVAL_REQUESTS
    });
  }
  const facts: EvidenceFact[] = [];
  for (const request of requests) {
    if (
      request.maxBytes <= 0 ||
      request.maxBytes > MAX_RETRIEVAL_BYTES ||
      (request.startByte !== undefined &&
        request.endByte !== undefined &&
        request.endByte < request.startByte)
    ) {
      return failure("LIMIT_EXCEEDED", "Evidence retrieval request is invalid", {
        obligationId: request.obligationId
      });
    }
    const adapter = adapters.get(request.adapterId);
    if (adapter === undefined) {
      return failure("INVALID_ARGUMENT", "Evidence retrieval adapter is missing", {
        adapterId: request.adapterId
      });
    }
    const retrieved = await adapter.retrieve(request);
    if (!retrieved.ok) return retrieved;
    let totalBytes = 0;
    for (const fact of retrieved.value) {
      totalBytes += fact.byteLength;
      if (
        fact.obligationId !== request.obligationId ||
        fact.byteLength !== Buffer.byteLength(fact.value, "utf8") ||
        fact.sha256 !== sha256Base64Url(Buffer.from(fact.value, "utf8")) ||
        (request.artifactId !== undefined &&
          fact.artifactId !== request.artifactId) ||
        (request.startByte !== undefined &&
          fact.startByte < request.startByte) ||
        (request.endByte !== undefined && fact.endByte > request.endByte) ||
        fact.origin !== "bounded-retrieval" ||
        !validFact(
          fact,
          {
            obligationId: request.obligationId,
            kind: fact.kind,
            description: request.purpose,
            key: fact.key,
            required: true
          },
          []
        )
      ) {
        return failure(
          "INTEGRITY_ERROR",
          "Evidence retrieval adapter returned an invalid fact",
          { obligationId: request.obligationId }
        );
      }
    }
    if (totalBytes > request.maxBytes) {
      return failure(
        "LIMIT_EXCEEDED",
        "Evidence retrieval exceeded aggregate maxBytes",
        { obligationId: request.obligationId, totalBytes }
      );
    }
    facts.push(...retrieved.value);
  }
  return success(facts);
}

export function assessFailureEvidence(input: {
  readonly artifact: ArtifactSnapshot;
  readonly evidence: readonly EvidenceSpan[];
  readonly additionalFacts?: readonly EvidenceFact[];
}): Result<{
  readonly reports: readonly FailureReport[];
  readonly sufficiency: EvidenceSufficiencyResult;
  readonly decision: ReturnType<GatherMoreEvidencePolicy["decide"]> extends Result<
    infer Value
  >
    ? Value
    : never;
}> {
  const reports = typedFailureParsers.parse(input.artifact);
  if (!reports.ok) return reports;
  const specs = buildFailureObligationSpecs({
    reports: reports.value,
    evidence: input.evidence
  });
  const facts = [
    ...factsFromFailureReports(reports.value, specs, input.evidence),
    ...(input.additionalFacts ?? [])
  ];
  const sufficiency = evidenceObligationEvaluator.evaluate(
    specs,
    facts,
    new Date(),
    input.evidence
  );
  const decision = gatherMoreEvidencePolicy.decide(sufficiency);
  if (!decision.ok) return decision;
  return success({
    reports: reports.value,
    sufficiency,
    decision: decision.value
  });
}

export const evidenceObligationEvaluator = new EvidenceObligationEvaluator();
export const gatherMoreEvidencePolicy = new GatherMoreEvidencePolicy();
