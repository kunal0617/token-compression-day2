import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import {
  isAbsolute,
  join,
  relative,
  resolve
} from "node:path";

import type {
  EvidenceRetrievalAdapter
} from "../contracts/obligations.js";
import type {
  EvaluationCase
} from "../contracts/evaluation.js";
import type { ProducerMetadata } from "../contracts/providers.js";
import type {
  ApprovedSourceCandidate
} from "../contracts/provenance.js";
import type {
  DeliveryRules,
  SourceDocument
} from "../contracts/source-scope.js";
import {
  approveReviewSubject,
  compareSnapshots,
  reviewSubjectProvider,
  validateApproval
} from "../approval/review.js";
import {
  classifyArtifact,
  determineOutcome
} from "../classify/classify.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import {
  sha256Base64Url
} from "../core/hash.js";
import { agentReadScopeDigest } from "../core/read-scope.js";
import {
  failure,
  success,
  type Result
} from "../core/result.js";
import { extractEvidence } from "../evidence/extract.js";
import {
  createCuratedModelPolicy,
  deterministicModelFitAdviser
} from "../model/advice.js";
import {
  assessFailureEvidence,
  createEvidenceFact,
  executeBoundedRetrieval
} from "../obligations/evaluate.js";
import { typedFailureParsers } from "../parsers/failures.js";
import { prepareContext } from "../pipeline/prepare.js";
import {
  exactSourceProvenanceProvider,
  validateSourceProvenance
} from "../provenance/exact.js";
import { buildDeliveryPlan } from "../source/delivery.js";
import { treeSitterJsTsStructureProvider } from "../source/tree-sitter.js";
import { ContextStore } from "../storage/store.js";
import { measureTokens } from "../token/tokenizer.js";
import {
  snapshotsFromManifest,
  verifyStoredRun
} from "../validate/validate.js";
import { snapshotBytes } from "../intake/intake.js";

export type ManualParityStatus =
  | "pass"
  | "fail"
  | "not-applicable";

export interface ManualParityCaseResult {
  readonly caseId: string;
  readonly contract: string;
  readonly status: ManualParityStatus;
  readonly inputDigest: string;
  readonly metrics: Readonly<
    Record<string, string | number | boolean>
  >;
  readonly reasons: readonly string[];
  readonly digest: string;
}

export interface ManualParityReport {
  readonly formatVersion: 1;
  readonly rootDigest: string;
  readonly cases: readonly ManualParityCaseResult[];
  readonly summary: {
    readonly passed: number;
    readonly failed: number;
    readonly notApplicable: number;
  };
  readonly producer: ProducerMetadata;
  readonly digest: string;
}

const expectedFiles = [
  "cq01-source-match/inventory-reconciler.ts",
  "cq01-source-match/request.txt",
  "cq02-diagnostics/request.txt",
  "cq03-incomplete/request.txt",
  "cq03-incomplete/complete-follow-up.txt",
  "cq04-repetition/request.txt",
  "cq05-source-scope/request.txt",
  "cq06-missing-fact/checkout-events.jsonl",
  "cq06-missing-fact/missing-response.txt",
  "cq06-missing-fact/observed-response.txt",
  "cq06-missing-fact/response-observation.json",
  "cq07-source-version/changed-config.txt",
  "cq07-source-version/dispatch-worker.captured.json",
  "cq07-source-version/dispatch-worker.current.json",
  "mf01-exact-operation/prompt.txt",
  "mf02-routine/prompt.txt",
  "mf03-reasoning/prompt.txt",
  "luna/prompt.txt"
] as const;

function producer(): ProducerMetadata {
  const producerId =
    "builtin.evaluation.external-manual-readonly";
  const version = "1.0.0";
  return {
    producerId,
    kind: "evaluation",
    version,
    digest: canonicalJsonDigest({
      producerId,
      version,
      contract: [
        "known-layout",
        "realpath-root-confinement",
        "direct-read-only",
        "no-subprocess",
        "no-network",
        "bounded-bytes",
        "bounded-duration",
        "digest-only-report"
      ]
    })
  };
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child.length === 0 ||
    (!child.startsWith("..") && !isAbsolute(child))
  );
}

function caseResult(input: Omit<ManualParityCaseResult, "digest">) {
  return {
    ...input,
    digest: canonicalJsonDigest(input)
  };
}

function fencedBodies(bytes: Buffer): readonly Buffer[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const bodies: Buffer[] = [];
  const pattern = /```[^\r\n]*\r?\n([\s\S]*?)```/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1] !== undefined) {
      bodies.push(Buffer.from(match[1], "utf8"));
    }
  }
  return bodies;
}

function flattenScalars(value: unknown): readonly string[] {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap(flattenScalars);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(flattenScalars);
  }
  return [];
}

const deliveryRules: DeliveryRules = {
  maxFiles: 4,
  maxBytes: 64 * 1024,
  maxDepth: 3,
  includeImports: true,
  includeDefinitions: true,
  includeTypes: true,
  includeTests: true
};

export class ExternalManualParityAdapter {
  readonly metadata = producer();
  readonly #root: string;
  readonly #maxFileBytes: number;
  readonly #maxTotalBytes: number;
  readonly #maxDurationMs: number;
  readonly #startedAt = Date.now();
  readonly #cache = new Map<string, Buffer>();
  #totalBytes = 0;

  constructor(input: {
    readonly root: string;
    readonly maxFileBytes?: number;
    readonly maxTotalBytes?: number;
    readonly maxDurationMs?: number;
  }) {
    this.#root = realpathSync(resolve(input.root));
    this.#maxFileBytes =
      input.maxFileBytes ?? 2 * 1024 * 1024;
    this.#maxTotalBytes =
      input.maxTotalBytes ?? 24 * 1024 * 1024;
    this.#maxDurationMs = input.maxDurationMs ?? 30_000;
  }

  #checkTime(): Result<void> {
    return Date.now() - this.#startedAt <= this.#maxDurationMs
      ? success(undefined)
      : failure(
          "LIMIT_EXCEEDED",
          "External manual parity duration exceeded its limit"
        );
  }

  #read(relativePath: string): Result<Buffer> {
    const time = this.#checkTime();
    if (!time.ok) return time;
    const cached = this.#cache.get(relativePath);
    if (cached !== undefined) {
      return success(Buffer.from(cached));
    }
    try {
      const path = realpathSync(
        resolve(this.#root, relativePath)
      );
      if (!inside(this.#root, path)) {
        return failure(
          "INVALID_ARGUMENT",
          "External manual fixture escapes its approved root"
        );
      }
      const bytes = readFileSync(path);
      this.#totalBytes += bytes.length;
      if (
        bytes.length > this.#maxFileBytes ||
        this.#totalBytes > this.#maxTotalBytes
      ) {
        return failure(
          "LIMIT_EXCEEDED",
          "External manual fixture exceeds configured byte limits"
        );
      }
      this.#cache.set(relativePath, Buffer.from(bytes));
      return success(bytes);
    } catch {
      return failure(
        "IO_ERROR",
        "External manual fixture file is unavailable"
      );
    }
  }

  #inputDigest(paths: readonly string[]): Result<string> {
    const identities = [];
    for (const path of paths) {
      const bytes = this.#read(path);
      if (!bytes.ok) return bytes;
      identities.push({
        sha256: sha256Base64Url(bytes.value),
        byteLength: bytes.value.length
      });
    }
    return success(canonicalJsonDigest(identities));
  }

  async #cq01(): Promise<ManualParityCaseResult> {
    const caseId = "cq01-source-match";
    const paths = [
      "cq01-source-match/request.txt",
      "cq01-source-match/inventory-reconciler.ts"
    ] as const;
    const digest = this.#inputDigest(paths);
    const request = this.#read(paths[0]);
    const source = this.#read(paths[1]);
    if (!digest.ok || !request.ok || !source.ok) {
      return caseResult({
        caseId,
        contract: "CQ-01",
        status: "fail",
        inputDigest: digest.ok ? digest.value : canonicalJsonDigest([]),
        metrics: {},
        reasons: ["Required approved source inputs were unavailable"]
      });
    }
    const query = fencedBodies(request.value)[0];
    if (query === undefined) {
      return caseResult({
        caseId,
        contract: "CQ-01",
        status: "fail",
        inputDigest: digest.value,
        metrics: { fencedCandidates: 0 },
        reasons: ["No exact source candidate was present"]
      });
    }
    const candidate: ApprovedSourceCandidate = {
      candidateId: "approved-source",
      label: "approved-source",
      approved: true,
      bytes: source.value,
      identity: {
        sha256: sha256Base64Url(source.value),
        byteLength: source.value.length
      }
    };
    const matched = exactSourceProvenanceProvider.provide({
      query,
      candidates: [candidate]
    });
    const mutated = {
      ...candidate,
      bytes: Buffer.from(candidate.bytes),
      identity: { ...candidate.identity }
    };
    if (mutated.bytes.length > 0) {
      mutated.bytes[0] = (mutated.bytes[0] ?? 0) ^ 1;
      mutated.identity = {
        sha256: sha256Base64Url(mutated.bytes),
        byteLength: mutated.bytes.length
      };
    }
    const mutationRejected =
      matched.ok &&
      !validateSourceProvenance(
        matched.value,
        query,
        [mutated]
      ).ok;
    const passed =
      matched.ok &&
      matched.value.state === "unique" &&
      mutationRejected;
    return caseResult({
      caseId,
      contract: "CQ-01",
      status: passed ? "pass" : "fail",
      inputDigest: digest.value,
      metrics: {
        queryBytes: query.length,
        sourceBytes: source.value.length,
        exactOccurrences:
          matched.ok ? matched.value.occurrences.length : 0,
        mutationRejected
      },
      reasons: [
        passed
          ? "Unique byte-exact provenance and mutation invalidation passed"
          : "Exact provenance contract did not hold"
      ]
    });
  }

  async #cq02(): Promise<ManualParityCaseResult> {
    const caseId = "cq02-diagnostics";
    const path = "cq02-diagnostics/request.txt";
    const digest = this.#inputDigest([path]);
    const bytes = this.#read(path);
    if (!digest.ok || !bytes.ok) {
      return caseResult({
        caseId,
        contract: "CQ-02",
        status: "fail",
        inputDigest: digest.ok ? digest.value : canonicalJsonDigest([]),
        metrics: {},
        reasons: ["Diagnostic fixture was unavailable"]
      });
    }
    const artifact = snapshotBytes(bytes.value, {
      ordinal: 0,
      role: "context",
      kind: "pasted",
      label: caseId
    });
    const parsed = typedFailureParsers.parse(artifact);
    const reports = parsed.ok ? parsed.value : [];
    const tests = reports.flatMap((report) => report.tests);
    const exceptions = reports.flatMap((report) => report.exceptions);
    const frames = exceptions.flatMap(
      (exception) => exception.frames
    );
    const passed =
      reports.some((report) => report.recognized) &&
      tests.length > 0 &&
      tests.some((test) => test.expected !== undefined) &&
      tests.some((test) => test.actual !== undefined) &&
      exceptions.length > 0 &&
      frames.length > 0 &&
      reports.some(
        (report) => report.exitCode !== undefined
      );
    return caseResult({
      caseId,
      contract: "CQ-02",
      status: passed ? "pass" : "fail",
      inputDigest: digest.value,
      metrics: {
        recognizedReports: reports.filter(
          (report) => report.recognized
        ).length,
        testFailures: tests.length,
        expectedValues: tests.filter(
          (test) => test.expected !== undefined
        ).length,
        actualValues: tests.filter(
          (test) => test.actual !== undefined
        ).length,
        exceptions: exceptions.length,
        stackFrames: frames.length,
        commands: reports.flatMap((report) => report.commands)
          .length
      },
      reasons: [
        passed
          ? "Typed test and Node/V8 diagnostic fields were extracted"
          : "Required typed diagnostic fields were incomplete"
      ]
    });
  }

  async #cq03(): Promise<ManualParityCaseResult> {
    const caseId = "cq03-incomplete";
    const paths = [
      "cq03-incomplete/request.txt",
      "cq03-incomplete/complete-follow-up.txt"
    ] as const;
    const digest = this.#inputDigest(paths);
    const initial = this.#read(paths[0]);
    const followUp = this.#read(paths[1]);
    if (!digest.ok || !initial.ok || !followUp.ok) {
      return caseResult({
        caseId,
        contract: "CQ-03",
        status: "fail",
        inputDigest: digest.ok ? digest.value : canonicalJsonDigest([]),
        metrics: {},
        reasons: ["Incomplete/follow-up fixture pair was unavailable"]
      });
    }
    const artifact = snapshotBytes(initial.value, {
      ordinal: 0,
      role: "context",
      kind: "pasted",
      label: caseId
    });
    const classification = classifyArtifact(artifact);
    const evidence = extractEvidence(
      artifact,
      classification,
      determineOutcome([artifact])
    );
    const before = assessFailureEvidence({
      artifact,
      evidence
    });
    const request =
      before.ok
        ? before.value.sufficiency.retrievalRequests[0]
        : undefined;
    if (request === undefined) {
      return caseResult({
        caseId,
        contract: "CQ-03",
        status: "fail",
        inputDigest: digest.value,
        metrics: { retrievalRequests: 0 },
        reasons: ["Incomplete evidence did not produce bounded retrieval"]
      });
    }
    const adapter: EvidenceRetrievalAdapter = {
      metadata: {
        producerId: request.adapterId,
        kind: "source-adapter",
        version: "1.0.0",
        digest: canonicalJsonDigest({
          caseId,
          adapterId: request.adapterId,
          inputDigest: digest.value
        })
      },
      retrieve: async (retrieval) => {
        const value = new TextDecoder("utf-8", {
          fatal: true
        }).decode(followUp.value);
        return success([
          createEvidenceFact({
            obligationId: retrieval.obligationId,
            kind: "failure-block",
            key: `${retrieval.artifactId}:typed-failure`,
            value,
            evidenceIds: [
              `external-follow-up:${sha256Base64Url(followUp.value)}`
            ],
            artifactId:
              retrieval.artifactId ?? artifact.artifactId,
            startByte: 0,
            endByte: followUp.value.length,
            sha256: sha256Base64Url(followUp.value),
            byteLength: followUp.value.length,
            origin: "bounded-retrieval"
          })
        ]);
      }
    };
    const retrieved = await executeBoundedRetrieval(
      [request],
      new Map([[request.adapterId, adapter]])
    );
    const after =
      retrieved.ok
        ? assessFailureEvidence({
            artifact,
            evidence,
            additionalFacts: retrieved.value.facts,
            trustedRetrievalProducers: [adapter.metadata],
            retrievalReceipts: retrieved.value.receipts
          })
        : retrieved;
    const passed =
      before.ok &&
      before.value.sufficiency.decision ===
        "gather-more-evidence" &&
      after.ok &&
      after.value.sufficiency.decision === "ready";
    return caseResult({
      caseId,
      contract: "CQ-03",
      status: passed ? "pass" : "fail",
      inputDigest: digest.value,
      metrics: {
        initialUnresolved: before.ok
          ? before.value.sufficiency.obligations.filter(
              (obligation) =>
                obligation.required &&
                obligation.status !== "satisfied"
            ).length
          : 0,
        retrievalRequests: before.ok
          ? before.value.sufficiency.retrievalRequests.length
          : 0,
        retrievedBytes: followUp.value.length,
        finalUnresolved: after.ok
          ? after.value.sufficiency.obligations.filter(
              (obligation) =>
                obligation.required &&
                obligation.status !== "satisfied"
            ).length
          : -1
      },
      reasons: [
        passed
          ? "Incomplete evidence gathered an exact bounded follow-up and became ready"
          : "Evidence gathering did not produce a ready obligation set"
      ]
    });
  }

  async #preparedCase(input: {
    readonly caseId: string;
    readonly contract: string;
    readonly path: string;
    readonly promptOnly?: boolean;
  }): Promise<ManualParityCaseResult> {
    const digest = this.#inputDigest([input.path]);
    const bytes = this.#read(input.path);
    if (!digest.ok || !bytes.ok) {
      return caseResult({
        caseId: input.caseId,
        contract: input.contract,
        status: "fail",
        inputDigest: digest.ok ? digest.value : canonicalJsonDigest([]),
        metrics: {},
        reasons: ["Fixture was unavailable"]
      });
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.value
      );
    } catch {
      return caseResult({
        caseId: input.caseId,
        contract: input.contract,
        status: "fail",
        inputDigest: digest.value,
        metrics: { utf8: false },
        reasons: ["Fixture is not valid UTF-8"]
      });
    }
    const directory = mkdtempSync(
      join(tmpdir(), "ctxo-external-parity-")
    );
    const storePath = join(directory, "context.sqlite");
    try {
      const prepared = await prepareContext(
        input.promptOnly
          ? { promptText: text, storePath }
          : {
              promptText: "Evaluate the external manual contract.",
              contextTexts: [
                { label: input.caseId, text }
              ],
              storePath
            }
      );
      if (!prepared.ok) {
        return caseResult({
          caseId: input.caseId,
          contract: input.contract,
          status: "fail",
          inputDigest: digest.value,
          metrics: { prepareSucceeded: false },
          reasons: ["Offline preparation returned a typed failure"]
        });
      }
      const store = new ContextStore(storePath);
      try {
        const verified = verifyStoredRun(
          store,
          prepared.value.package.runId
        );
        const handlesResolve =
          verified.ok &&
          prepared.value.receipt.handles.every(
            (handle) => store.retrieve(handle).ok
          );
        const reduction =
          prepared.value.receipt.tokenReductionPercent;
        const cq04Passed =
          input.contract !== "CQ-04" ||
          (reduction > 0 &&
            prepared.value.receipt.handles.length > 0);
        const passed =
          verified.ok &&
          handlesResolve &&
          cq04Passed;
        return caseResult({
          caseId: input.caseId,
          contract: input.contract,
          status:
            input.contract === "Luna-style"
              ? passed
                ? "not-applicable"
                : "fail"
              : passed
                ? "pass"
                : "fail",
          inputDigest: digest.value,
          metrics: {
            originalTokens:
              prepared.value.receipt.originalTokens,
            preparedTokens:
              prepared.value.receipt.preparedTokens,
            tokenReductionPercent: reduction,
            handles: prepared.value.receipt.handles.length,
            integrityVerified: verified.ok,
            reconstructionByteIdentical:
              verified.ok &&
              verified.value.validation.reconstruction ===
                "byte-identical",
            liveExecution: false
          },
          reasons: [
            input.contract === "Luna-style"
              ? passed
                ? "Local pass-through integrity was verified; live Luna execution is not applicable to the read-only adapter"
                : "Local Luna pass-through integrity failed"
              : passed
                ? "Repetition reduction, retrieval, integrity, and reconstruction passed"
                : "Prepared contract did not satisfy reduction or integrity requirements"
          ]
        });
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  async #cq05(): Promise<ManualParityCaseResult> {
    const caseId = "cq05-source-scope";
    const path = "cq05-source-scope/request.txt";
    const digest = this.#inputDigest([path]);
    const bytes = this.#read(path);
    if (!digest.ok || !bytes.ok) {
      return caseResult({
        caseId,
        contract: "CQ-05",
        status: "fail",
        inputDigest: digest.ok ? digest.value : canonicalJsonDigest([]),
        metrics: {},
        reasons: ["Source-scope fixture was unavailable"]
      });
    }
    const document: SourceDocument = {
      sourceId: caseId,
      path: "external-request.ts",
      language: "typescript",
      bytes: bytes.value,
      identity: {
        sha256: sha256Base64Url(bytes.value),
        byteLength: bytes.value.length
      }
    };
    const units = treeSitterJsTsStructureProvider.units({
      document
    });
    const root = units.ok
      ? units.value.find(
          (unit) => unit.kind === "function"
        )
      : undefined;
    const plan =
      root === undefined
        ? failure(
            "INTEGRITY_ERROR",
            "No byte-precise function root was found"
          )
        : buildDeliveryPlan({
            documents: [document],
            roots: [
              {
                sourceId: document.sourceId,
                startByte: root.startByte,
                endByte: root.endByte
              }
            ],
            rules: deliveryRules
          });
    const rootIncluded =
      plan.ok &&
      plan.value.slices.some(
        (slice) =>
          slice.startByte <= (root?.startByte ?? -1) &&
          slice.endByte >= (root?.endByte ?? -1)
      );
    const passed =
      units.ok &&
      units.value.length > 1 &&
      plan.ok &&
      rootIncluded &&
      plan.value.totalBytes < bytes.value.length;
    return caseResult({
      caseId,
      contract: "CQ-05",
      status: passed ? "pass" : "fail",
      inputDigest: digest.value,
      metrics: {
        structuralUnits: units.ok ? units.value.length : 0,
        selectedSlices: plan.ok ? plan.value.slices.length : 0,
        selectedBytes: plan.ok ? plan.value.totalBytes : 0,
        omittedBytes: plan.ok
          ? bytes.value.length - plan.value.totalBytes
          : 0,
        rootIncluded
      },
      reasons: [
        passed
          ? "Byte-precise rooted delivery retained the root and omitted unrelated ranges"
          : "Source delivery did not establish a bounded rooted scope"
      ]
    });
  }

  async #cq06(): Promise<ManualParityCaseResult> {
    const caseId = "cq06-missing-fact";
    const paths = [
      "cq06-missing-fact/checkout-events.jsonl",
      "cq06-missing-fact/missing-response.txt",
      "cq06-missing-fact/observed-response.txt",
      "cq06-missing-fact/response-observation.json"
    ] as const;
    const digest = this.#inputDigest(paths);
    const missing = this.#read(paths[1]);
    const observed = this.#read(paths[2]);
    const observation = this.#read(paths[3]);
    if (
      !digest.ok ||
      !missing.ok ||
      !observed.ok ||
      !observation.ok
    ) {
      return caseResult({
        caseId,
        contract: "CQ-06",
        status: "fail",
        inputDigest: digest.ok ? digest.value : canonicalJsonDigest([]),
        metrics: {},
        reasons: ["Missing/observed fact fixtures were unavailable"]
      });
    }
    let scalars: readonly string[] = [];
    try {
      scalars = flattenScalars(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            observation.value
          )
        )
      ).filter((value) => value.length > 0);
    } catch {
      scalars = [];
    }
    const observedHits = scalars.filter((value) =>
      observed.value.includes(Buffer.from(value, "utf8"))
    ).length;
    const missingHits = scalars.filter((value) =>
      missing.value.includes(Buffer.from(value, "utf8"))
    ).length;
    const missingArtifact = snapshotBytes(missing.value, {
      ordinal: 0,
      role: "context",
      kind: "pasted",
      label: `${caseId}-missing`
    });
    const observedArtifact = snapshotBytes(observed.value, {
      ordinal: 1,
      role: "context",
      kind: "pasted",
      label: `${caseId}-observed`
    });
    const missingEvidence = extractEvidence(
      missingArtifact,
      classifyArtifact(missingArtifact),
      determineOutcome([missingArtifact])
    );
    const observedEvidence = extractEvidence(
      observedArtifact,
      classifyArtifact(observedArtifact),
      determineOutcome([observedArtifact])
    );
    const passed =
      scalars.length > 0 &&
      observedHits === scalars.length &&
      missingHits < observedHits &&
      observedEvidence.length > missingEvidence.length;
    return caseResult({
      caseId,
      contract: "CQ-06",
      status: passed ? "pass" : "fail",
      inputDigest: digest.value,
      metrics: {
        requiredFacts: scalars.length,
        missingFactHits: missingHits,
        observedFactHits: observedHits,
        missingEvidence: missingEvidence.length,
        observedEvidence: observedEvidence.length
      },
      reasons: [
        passed
          ? "The observed response satisfied exact facts absent from the incomplete response"
          : "Missing/observed fact distinction was not preserved"
      ]
    });
  }

  async #cq07(): Promise<ManualParityCaseResult> {
    const caseId = "cq07-source-version";
    const paths = [
      "cq07-source-version/changed-config.txt",
      "cq07-source-version/dispatch-worker.captured.json",
      "cq07-source-version/dispatch-worker.current.json"
    ] as const;
    const digest = this.#inputDigest(paths);
    const captured = this.#read(paths[1]);
    const current = this.#read(paths[2]);
    if (!digest.ok || !captured.ok || !current.ok) {
      return caseResult({
        caseId,
        contract: "CQ-07",
        status: "fail",
        inputDigest: digest.ok ? digest.value : canonicalJsonDigest([]),
        metrics: {},
        reasons: ["Captured/current fixture pair was unavailable"]
      });
    }
    const runId = "external-cq07";
    const readScope = agentReadScopeDigest({
      runId,
      evidence: [],
      sources: []
    });
    if (!readScope.ok) {
      return caseResult({
        caseId,
        contract: "CQ-07",
        status: "fail",
        inputDigest: digest.value,
        metrics: {},
        reasons: ["Review read scope could not be canonicalized"]
      });
    }
    const common = {
      runId,
      policyDigest: canonicalJsonDigest("external-policy"),
      detectorRegistryDigest: canonicalJsonDigest(
        "external-detectors"
      ),
      reviewProducerRegistry: {
        digest: canonicalJsonDigest([]),
        producers: []
      },
      readScopeDigest: readScope.value,
      evidenceDecision: "ready" as const,
      tokenizer: "o200k_base",
      target: {
        adapterId: "offline",
        modelId: "external-model",
        workingDirectory: "external-read-only",
        permissions: {
          sourceRead: false,
          evidenceRead: false,
          fileWrite: false,
          shell: false,
          network: false
        }
      }
    };
    const capturedSubject = reviewSubjectProvider.provide({
      ...common,
      payload: captured.value,
      sourceIdentities: [
        {
          sourceId: "captured",
          identity: {
            sha256: sha256Base64Url(captured.value),
            byteLength: captured.value.length
          }
        }
      ],
      snapshotChoice: "captured",
      payloadRole: "captured"
    });
    const capturedApproval =
      capturedSubject.ok
        ? approveReviewSubject({
            subject: capturedSubject.value,
            payload: captured.value,
            decision: "keep-original"
          })
        : capturedSubject;
    const currentSubject = reviewSubjectProvider.provide({
      ...common,
      payload: current.value,
      sourceIdentities: [
        {
          sourceId: "current",
          identity: {
            sha256: sha256Base64Url(current.value),
            byteLength: current.value.length
          }
        }
      ],
      snapshotChoice: "current",
      payloadRole: "current"
    });
    const staleRejected =
      capturedSubject.ok &&
      capturedApproval.ok &&
      currentSubject.ok &&
      !validateApproval({
        subject: currentSubject.value,
        approval: capturedApproval.value,
        payload: current.value
      }).ok;
    const comparison = compareSnapshots(
      captured.value,
      current.value
    );
    const passed =
      comparison.state === "changed" &&
      capturedApproval.ok &&
      staleRejected;
    return caseResult({
      caseId,
      contract: "CQ-07",
      status: passed ? "pass" : "fail",
      inputDigest: digest.value,
      metrics: {
        capturedBytes: captured.value.length,
        currentBytes: current.value.length,
        snapshotsChanged: comparison.state === "changed",
        staleApprovalRejected: staleRejected
      },
      reasons: [
        passed
          ? "Captured/current divergence invalidated the prior approval"
          : "Snapshot change or stale approval rejection failed"
      ]
    });
  }

  async #modelCase(input: {
    readonly caseId: string;
    readonly contract: "MF-01" | "MF-02" | "MF-03";
    readonly path: string;
    readonly operation:
      | "MF-01-exact-operation"
      | "MF-02-bounded-routine"
      | "MF-03-reasoning-intensive";
    readonly currentModelId: string;
    readonly expectedDecision:
      | "keep-current"
      | "recommend-new-session";
  }): Promise<ManualParityCaseResult> {
    const digest = this.#inputDigest([input.path]);
    const bytes = this.#read(input.path);
    if (!digest.ok || !bytes.ok) {
      return caseResult({
        caseId: input.caseId,
        contract: input.contract,
        status: "fail",
        inputDigest: digest.ok ? digest.value : canonicalJsonDigest([]),
        metrics: {},
        reasons: ["Model-fit prompt fixture was unavailable"]
      });
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.value
      );
    } catch {
      text = "";
    }
    const tokens = measureTokens(text, text);
    const catalog = [
      {
        id: "exact",
        name: "Exact",
        capabilities: {
          maxInputTokens: 64_000,
          supportsTools: true,
          supportsReasoning: false,
          latencyTier: 1,
          costTier: 1,
          reasoningTier: 1
        }
      },
      {
        id: "routine",
        name: "Routine",
        capabilities: {
          maxInputTokens: 128_000,
          supportsTools: true,
          supportsReasoning: false,
          latencyTier: 2,
          costTier: 1,
          reasoningTier: 2
        }
      },
      {
        id: "reasoning",
        name: "Reasoning",
        capabilities: {
          maxInputTokens: 128_000,
          supportsTools: true,
          supportsReasoning: true,
          latencyTier: 4,
          costTier: 4,
          reasoningTier: 10
        }
      }
    ];
    const policy = createCuratedModelPolicy({
      version: "external-manual-v1",
      entries: [
        {
          modelId: "exact",
          allowedOperations: ["MF-01-exact-operation"],
          enabled: true
        },
        {
          modelId: "routine",
          allowedOperations: ["MF-02-bounded-routine"],
          enabled: true
        },
        {
          modelId: "reasoning",
          allowedOperations: [
            "MF-03-reasoning-intensive"
          ],
          enabled: true
        }
      ]
    });
    const advice =
      tokens.ok
        ? deterministicModelFitAdviser.provide({
            operation: input.operation,
            currentModelId: input.currentModelId,
            requiredInputTokens: tokens.value.originalTokens,
            requiresTools: true,
            requiresVision: false,
            evidenceDecision: "ready",
            catalog,
            policy
          })
        : tokens;
    const passed =
      advice.ok &&
      advice.value.decision === input.expectedDecision;
    return caseResult({
      caseId: input.caseId,
      contract: input.contract,
      status: passed ? "pass" : "fail",
      inputDigest: digest.value,
      metrics: {
        actualTokens: tokens.ok
          ? tokens.value.originalTokens
          : 0,
        eligibleModels: advice.ok
          ? advice.value.scores.filter((score) => score.eligible)
              .length
          : 0,
        decision: advice.ok
          ? advice.value.decision
          : "typed-failure",
        requiresNewSession: advice.ok
          ? advice.value.requiresNewSession
          : false
      },
      reasons: [
        passed
          ? "Deterministic model-fit decision matched the contract class"
          : "Model-fit decision did not match the contract class"
      ]
    });
  }

  async run(): Promise<Result<ManualParityReport>> {
    const rootDigestParts = [];
    for (const path of expectedFiles) {
      const bytes = this.#read(path);
      if (!bytes.ok) return bytes;
      rootDigestParts.push({
        sha256: sha256Base64Url(bytes.value),
        byteLength: bytes.value.length
      });
    }
    const cases = [
      await this.#cq01(),
      await this.#cq02(),
      await this.#cq03(),
      await this.#preparedCase({
        caseId: "cq04-repetition",
        contract: "CQ-04",
        path: "cq04-repetition/request.txt"
      }),
      await this.#cq05(),
      await this.#cq06(),
      await this.#cq07(),
      await this.#modelCase({
        caseId: "mf01-exact-operation",
        contract: "MF-01",
        path: "mf01-exact-operation/prompt.txt",
        operation: "MF-01-exact-operation",
        currentModelId: "exact",
        expectedDecision: "keep-current"
      }),
      await this.#modelCase({
        caseId: "mf02-routine",
        contract: "MF-02",
        path: "mf02-routine/prompt.txt",
        operation: "MF-02-bounded-routine",
        currentModelId: "exact",
        expectedDecision: "recommend-new-session"
      }),
      await this.#modelCase({
        caseId: "mf03-reasoning",
        contract: "MF-03",
        path: "mf03-reasoning/prompt.txt",
        operation: "MF-03-reasoning-intensive",
        currentModelId: "routine",
        expectedDecision: "recommend-new-session"
      }),
      await this.#preparedCase({
        caseId: "luna",
        contract: "Luna-style",
        path: "luna/prompt.txt",
        promptOnly: true
      })
    ];
    const unsigned = {
      formatVersion: 1 as const,
      rootDigest: canonicalJsonDigest(rootDigestParts),
      cases,
      summary: {
        passed: cases.filter((item) => item.status === "pass")
          .length,
        failed: cases.filter((item) => item.status === "fail")
          .length,
        notApplicable: cases.filter(
          (item) => item.status === "not-applicable"
        ).length
      },
      producer: this.metadata
    };
    return success({
      ...unsigned,
      digest: canonicalJsonDigest(unsigned)
    });
  }
}

export function manualParityEvaluationCase(
  result: ManualParityCaseResult
): EvaluationCase {
  return {
    caseId: result.caseId,
    title: result.contract,
    prompt: "External manual read-only contract result",
    artifactPaths: [],
    artifactIdentities: [],
    expectedEvidenceIds: [],
    expectedFailureIds: [],
    expectedCitations: [],
    allowAbstention: result.status === "not-applicable",
    source: "external"
  };
}

export function manualParityExitCode(
  report: ManualParityReport
): 0 | 1 {
  return report.summary.failed === 0 ? 0 : 1;
}

export const externalManualParityProducer = Object.freeze({
  metadata: producer()
});
