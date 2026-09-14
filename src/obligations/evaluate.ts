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
    if (!report.recognized) {
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
  reports: readonly FailureReport[]
): readonly EvidenceFact[] {
  const facts: EvidenceFact[] = [];
  for (const report of reports) {
    for (const test of report.tests) {
      const base = `${report.artifactId}:${test.testName}`;
      facts.push({
        factId: deterministicUuid(`${base}:failure`),
        kind: "failure-block",
        key: base,
        value: test.testName,
        evidenceIds: []
      });
      if (test.expected !== undefined) {
        facts.push({
          factId: deterministicUuid(`${base}:expected:${test.expected}`),
          kind: "expected-value",
          key: `${base}:expected`,
          value: test.expected,
          evidenceIds: []
        });
      }
      if (test.actual !== undefined) {
        facts.push({
          factId: deterministicUuid(`${base}:actual:${test.actual}`),
          kind: "actual-value",
          key: `${base}:actual`,
          value: test.actual,
          evidenceIds: []
        });
      }
    }
    for (const exception of flattenExceptions(report.exceptions)) {
      facts.push({
        factId: deterministicUuid(
          `${report.artifactId}:${exception.type}:${exception.startByte}`
        ),
        kind: "failure-block",
        key: `${report.artifactId}:${exception.type}:${exception.startByte}`,
        value: `${exception.type}: ${exception.message}`,
        evidenceIds: []
      });
    }
    if (report.commands.length > 0 || report.exitCode !== undefined) {
      facts.push({
        factId: deterministicUuid(`${report.artifactId}:command-exit`),
        kind: "command-exit",
        key: `${report.artifactId}:command-exit`,
        value: `${report.commands.at(-1)?.command ?? "unknown"}:${
          report.exitCode ?? "unknown"
        }`,
        evidenceIds: []
      });
    }
    if (report.environment.length > 0) {
      facts.push({
        factId: deterministicUuid(`${report.artifactId}:runtime`),
        kind: "runtime",
        key: `${report.artifactId}:runtime`,
        value: report.environment
          .map((fact) => `${fact.key}=${fact.value}`)
          .join(";"),
        evidenceIds: []
      });
    }
  }
  return facts;
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
    now = new Date()
  ): EvidenceSufficiencyResult {
    const obligations: EvidenceObligation[] = specs.map((item) => {
      const matches = facts.filter(
        (fact) => fact.kind === item.kind && fact.key === item.key
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
        description: item.description,
        status,
        evidenceIds: matches.flatMap((fact) => fact.evidenceIds),
        reasons,
        producer: this.metadata
      };
    });
    const unresolved = obligations.filter(
      (obligation) => obligation.status !== "satisfied"
    );
    const unresolvedIds = new Set(
      unresolved.map((obligation) => obligation.obligationId)
    );
    const retrievalRequests = specs
      .filter(
        (item) =>
          unresolvedIds.has(item.obligationId) && item.retrieval !== undefined
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
      (obligation) => obligation.status !== "satisfied"
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
    ...factsFromFailureReports(reports.value),
    ...(input.additionalFacts ?? [])
  ];
  const sufficiency = evidenceObligationEvaluator.evaluate(specs, facts);
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
