import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import type {
  ApprovedReviewPayload,
  CurrentSnapshotCapture,
  ReviewAction,
  ReviewViewModel,
  TerminalReviewInput
} from "../contracts/tui.js";
import type { ApprovalRecord, ReviewSubject } from "../contracts/approval.js";
import type { EvidenceObligation } from "../contracts/providers.js";
import type {
  EvidenceFact,
  EvidenceRetrievalAdapter,
  EvidenceRetrievalExecution,
  EvidenceRetrievalRequest,
  EvidenceRetrievalReceipt
} from "../contracts/obligations.js";
import type { SourceSnapshotIdentity } from "../contracts/provenance.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import { sha256Base64Url } from "../core/hash.js";
import { agentReadScopeDigest } from "../core/read-scope.js";
import { failure, success, type Result } from "../core/result.js";
import {
  approveReviewSubject,
  reviewSubjectProvider,
  selectSnapshot,
  validateApproval
} from "../approval/review.js";
import { assessFailureEvidence } from "../obligations/evaluate.js";
import { builtinRuntime } from "../registry/builtins.js";
import { assessSecurity } from "../security/security.js";

export interface ReviewRetrievalPort {
  retrieve(handle: string): Result<Buffer>;
  loadReviewFacts?(runId: string): Result<readonly EvidenceFact[]>;
  saveReviewFacts?(
    runId: string,
    facts: readonly EvidenceFact[]
  ): Result<void>;
  loadEvidenceRetrievalReceipts?(
    runId: string
  ): Result<readonly EvidenceRetrievalReceipt[]>;
  executeEvidenceRetrieval?(
    runId: string,
    requests: readonly EvidenceRetrievalRequest[],
    adapters: ReadonlyMap<string, EvidenceRetrievalAdapter>
  ): Promise<Result<EvidenceRetrievalExecution>>;
}

function sourceDiff(input: TerminalReviewInput): readonly string[] {
  return input.contextPackage.manifest.omissions.map(
    (omission) =>
      `- ${omission.artifactId} [${omission.startByte},${omission.endByte}) ${omission.reason} ${omission.byteLength} bytes\n+ ${omission.marker.trim()}`
  );
}

function evidenceLines(input: TerminalReviewInput): readonly string[] {
  return input.contextPackage.manifest.evidence
    .filter((evidence) => evidence.mandatoryInline)
    .map(
      (evidence) =>
        `${evidence.kind} ${evidence.artifactId} [${evidence.startByte},${evidence.endByte}) ${evidence.textPreview}`
    );
}

function transformationLines(input: TerminalReviewInput): readonly string[] {
  return input.contextPackage.manifest.transforms.map(
    (transform) =>
      `${transform.reason} ${transform.artifactId} [${transform.startByte},${transform.endByte}) count=${transform.sourceCount}`
  );
}

function obligations(
  input: TerminalReviewInput,
  gatheredFacts: readonly EvidenceFact[]
  ,
  retrievalReceipts: readonly EvidenceRetrievalReceipt[]
): readonly EvidenceObligation[] {
  const results: EvidenceObligation[] = [];
  for (const artifact of input.artifacts) {
    if (artifact.role === "prompt") continue;
    const assessed = assessFailureEvidence({
      artifact,
      evidence: input.contextPackage.manifest.evidence.filter(
        (evidence) => evidence.artifactId === artifact.artifactId
      ),
      additionalFacts: gatheredFacts,
      trustedRetrievalProducers: [
        ...(input.retrievalAdapters?.values() ?? [])
      ].map((adapter) => adapter.metadata),
      retrievalReceipts
    });
    if (assessed.ok) results.push(...assessed.value.sufficiency.obligations);
  }
  return results;
}

function sourceIdentities(input: TerminalReviewInput) {
  return input.contextPackage.manifest.artifacts.map((artifact) => ({
    sourceId: artifact.artifactId,
    identity: {
      sha256: artifact.sha256,
      byteLength: artifact.byteLength
    }
  }));
}

export class TerminalReviewController {
  readonly #input: TerminalReviewInput;
  readonly #retrieval: ReviewRetrievalPort;
  #target;
  #selectedBytes: Buffer;
  #selectedSourceIdentities: readonly {
    readonly sourceId: string;
    readonly identity: SourceSnapshotIdentity;
  }[];
  #selectedSnapshot: ReviewViewModel["selectedSnapshot"] = "captured";
  #payloadRole: ReviewSubject["payloadRole"] = "prepared";
  #subject: ReviewSubject | undefined;
  #approval: ApprovalRecord | undefined;
  #authorityToken: string | undefined;
  #status: ReviewViewModel["status"] = "reviewing";
  readonly #security;
  #gatheredFacts: EvidenceFact[];
  #retrievalReceipts: EvidenceRetrievalReceipt[];

  constructor(input: TerminalReviewInput, retrieval: ReviewRetrievalPort) {
    this.#input = input;
    this.#retrieval = retrieval;
    this.#target = input.target;
    this.#selectedBytes = Buffer.from(input.contextPackage.preparedBytes);
    this.#selectedSourceIdentities = sourceIdentities(input);
    const persisted = retrieval.loadReviewFacts?.(
      input.contextPackage.runId
    );
    this.#gatheredFacts = [
      ...(input.gatheredFacts ?? []),
      ...(persisted?.ok ? persisted.value : [])
    ];
    const persistedReceipts =
      retrieval.loadEvidenceRetrievalReceipts?.(
        input.contextPackage.runId
      );
    this.#retrievalReceipts = persistedReceipts?.ok
      ? [...persistedReceipts.value]
      : [];
    this.#security = assessSecurity(
      input.artifacts.map((artifact) => ({
        sourceId: artifact.artifactId,
        bytes: artifact.bytes,
        trustClass:
          artifact.role === "prompt"
            ? ("user-instruction" as const)
            : ("build-output" as const)
      }))
    );
  }

  #clearApproval(): void {
    this.#subject = undefined;
    this.#approval = undefined;
    this.#authorityToken = undefined;
    if (this.#status === "approved") this.#status = "reviewing";
  }

  #captureCurrent(): Result<CurrentSnapshotCapture> {
    const current = this.#input.currentSource?.capture();
    return (
      current ??
      failure(
        "INVALID_ARGUMENT",
        "Current source recapture is unavailable"
      )
    );
  }

  #approve(
    decision:
      | "approve-prepared"
      | "approve-selected"
      | "keep-original"
      | "approve-merged"
  ): Result<void> {
    const gaps = this.view().gaps;
    if (gaps.length > 0) {
      return failure(
        "INVALID_ARGUMENT",
        "Gather More Evidence must resolve blocking obligations before approval",
        { obligations: gaps.map((gap) => gap.obligationId) }
      );
    }
    if (
      this.#selectedSnapshot === "current" ||
      this.#selectedSnapshot === "both"
    ) {
      const current = this.#captureCurrent();
      if (!current.ok) return current;
      const selected = selectSnapshot({
        choice: this.#selectedSnapshot,
        captured: this.#input.capturedBytes,
        current: current.value.bytes
      });
      if (
        !selected.ok ||
        !selected.value.bytes.equals(this.#selectedBytes)
      ) {
        this.#clearApproval();
        return failure(
          "INTEGRITY_ERROR",
          "Current source changed during review; select it again"
        );
      }
      this.#selectedSourceIdentities =
        this.#selectedSnapshot === "current"
          ? current.value.sourceIdentities
          : [
              ...sourceIdentities(this.#input).map((item) => ({
                sourceId: `captured:${item.sourceId}`,
                identity: item.identity
              })),
              ...current.value.sourceIdentities.map((item) => ({
                sourceId: `current:${item.sourceId}`,
                identity: item.identity
              }))
            ];
    }
    const readScopeDigest = agentReadScopeDigest(this.#input.readScope);
    if (!readScopeDigest.ok) return readScopeDigest;
    const subject = reviewSubjectProvider.provide({
      runId: this.#input.contextPackage.runId,
      payload: this.#selectedBytes,
      sourceIdentities: this.#selectedSourceIdentities,
      policyDigest: canonicalJsonDigest(
        this.#input.contextPackage.manifest.policy ?? {
          nearbySegments: 1
        }
      ),
      detectorRegistryDigest:
        this.#input.contextPackage.manifest.producerRegistry?.digest ??
        builtinRuntime.registryDigest,
      reviewProducerRegistry: {
        digest: builtinRuntime.reviewRegistryDigest,
        producers: builtinRuntime.reviewProducers
      },
      readScopeDigest: readScopeDigest.value,
      evidenceDecision: gaps.length === 0 ? "ready" : "gather-more-evidence",
      tokenizer: this.#input.contextPackage.manifest.tokenizer.encoding,
      target: this.#target,
      snapshotChoice: this.#selectedSnapshot,
      payloadRole: this.#payloadRole
    });
    if (!subject.ok) return subject;
    const approval = approveReviewSubject({
      subject: subject.value,
      payload: this.#selectedBytes,
      decision
    });
    if (!approval.ok) return approval;
    const requiresCommittedAuthority =
      this.#payloadRole === "prepared" ||
      this.#payloadRole === "captured" ||
      this.#target.permissions.network;
    let authorityToken: string;
    if (requiresCommittedAuthority) {
      if (this.#input.approvalAuthority === undefined) {
        return failure(
          "INTEGRITY_ERROR",
          "A committed-run approval authority is required"
        );
      }
      const authority = this.#input.approvalAuthority.issueReview({
        runId: this.#input.contextPackage.runId,
        approved: {
          bytes: Buffer.from(this.#selectedBytes),
          subject: subject.value,
          approval: approval.value,
          evidenceFacts: [...this.#gatheredFacts]
        },
        readScope: this.#input.readScope
      });
      if (!authority.ok) return authority;
      authorityToken = authority.value;
    } else {
      authorityToken = `ctxo-local-review:v1:${approval.value.digest}`;
    }
    this.#subject = subject.value;
    this.#approval = approval.value;
    this.#authorityToken = authorityToken;
    this.#status = "approved";
    return success(undefined);
  }

  dispatch(action: ReviewAction): Result<Buffer | void> {
    if (action.type === "retrieve") {
      return this.#retrieval.retrieve(action.handle);
    }
    if (action.type === "set-target") {
      this.#target = action.target;
      this.#clearApproval();
      return success(undefined);
    }
    if (action.type === "edit-result") {
      this.#selectedBytes = Buffer.from(action.bytes);
      this.#selectedSnapshot = "editable-merge";
      this.#payloadRole = "merged";
      this.#clearApproval();
      return success(undefined);
    }
    if (action.type === "choose-snapshot") {
      let currentBytes = this.#input.capturedBytes;
      let currentIdentities: readonly {
        readonly sourceId: string;
        readonly identity: SourceSnapshotIdentity;
      }[] = sourceIdentities(this.#input);
      if (action.choice !== "captured") {
        const current = this.#captureCurrent();
        if (!current.ok) return current;
        currentBytes = current.value.bytes;
        currentIdentities = current.value.sourceIdentities;
      }
      const selected = selectSnapshot({
        choice: action.choice,
        captured: this.#input.capturedBytes,
        current: currentBytes,
        ...(action.choice === "editable-merge"
          ? { editedMerge: this.#selectedBytes }
          : {})
      });
      if (!selected.ok) return selected;
      this.#selectedBytes = selected.value.bytes;
      this.#selectedSnapshot = action.choice;
      this.#payloadRole =
        action.choice === "current"
          ? "current"
          : action.choice === "both"
            ? "both"
            : action.choice === "editable-merge"
              ? "merged"
              : "captured";
      this.#selectedSourceIdentities =
        action.choice === "captured"
          ? sourceIdentities(this.#input)
          : action.choice === "current"
            ? currentIdentities
            : [
                ...sourceIdentities(this.#input).map((item) => ({
                  sourceId: `captured:${item.sourceId}`,
                  identity: item.identity
                })),
                ...currentIdentities.map((item) => ({
                  sourceId: `current:${item.sourceId}`,
                  identity: item.identity
                }))
              ];
      this.#clearApproval();
      return success(undefined);
    }

    if (action.type === "approve-prepared") {
      this.#selectedBytes = Buffer.from(
        this.#input.contextPackage.preparedBytes
      );
      this.#selectedSnapshot = "captured";
      this.#payloadRole = "prepared";
      this.#selectedSourceIdentities = sourceIdentities(this.#input);
      return this.#approve("approve-prepared");
    }
    if (action.type === "approve-selected") {
      return this.#approve("approve-selected");
    }
    if (action.type === "keep-original") {
      this.#selectedBytes = Buffer.from(this.#input.capturedBytes);
      this.#selectedSnapshot = "captured";
      this.#payloadRole = "captured";
      this.#selectedSourceIdentities = sourceIdentities(this.#input);
      return this.#approve("keep-original");
    }
    if (action.type === "approve-merged") {
      if (this.#selectedSnapshot !== "editable-merge") {
        return failure(
          "INVALID_ARGUMENT",
          "No edited result is selected for merged approval"
        );
      }
      return this.#approve("approve-merged");
    }
    if (action.type === "gather-evidence") {
      this.#status = "gather-evidence";
      this.#clearApproval();
      return success(undefined);
    }
    if (action.type === "reject") {
      this.#status = "rejected";
      this.#clearApproval();
      return success(undefined);
    }
    this.#status = "cancelled";
    this.#clearApproval();
    return success(undefined);
  }

  async gatherEvidence(): Promise<Result<void>> {
    if (this.#input.retrievalAdapters === undefined) {
      return failure(
        "INVALID_ARGUMENT",
        "No approved bounded retrieval adapters are configured"
      );
    }
    const retrievalAdapters = this.#input.retrievalAdapters;
    const requests = this.#input.artifacts
      .filter((artifact) => artifact.role !== "prompt")
      .flatMap((artifact) => {
        const assessed = assessFailureEvidence({
          artifact,
          evidence: this.#input.contextPackage.manifest.evidence.filter(
            (evidence) => evidence.artifactId === artifact.artifactId
          ),
          additionalFacts: this.#gatheredFacts,
          trustedRetrievalProducers: [
            ...retrievalAdapters.values()
          ].map((adapter) => adapter.metadata),
          retrievalReceipts: this.#retrievalReceipts
        });
        return assessed.ok
          ? assessed.value.sufficiency.retrievalRequests
          : [];
      });
    if (requests.length === 0) {
      return failure(
        "INVALID_ARGUMENT",
        "No unresolved obligation has a bounded retrieval request"
      );
    }
    if (this.#retrieval.executeEvidenceRetrieval === undefined) {
      return failure(
        "INTEGRITY_ERROR",
        "The retrieval store cannot issue authoritative execution receipts"
      );
    }
    const retrieved =
      await this.#retrieval.executeEvidenceRetrieval(
        this.#input.contextPackage.runId,
        requests,
        retrievalAdapters
      );
    if (!retrieved.ok) return retrieved;
    this.#retrievalReceipts = [
      ...this.#retrievalReceipts,
      ...retrieved.value.receipts
    ];
    this.#gatheredFacts = [
      ...new Map(
        [
          ...this.#gatheredFacts,
          ...retrieved.value.facts
        ].map((fact) => [
          fact.factId,
          fact
        ])
      ).values()
    ];
    const saved = this.#retrieval.saveReviewFacts?.(
      this.#input.contextPackage.runId,
      this.#gatheredFacts
    );
    if (saved !== undefined && !saved.ok) return saved;
    this.#clearApproval();
    this.#status = "reviewing";
    return success(undefined);
  }

  approvedPayload(): Result<ApprovedReviewPayload> {
    if (
      this.#subject === undefined ||
      this.#approval === undefined ||
      this.#authorityToken === undefined
    ) {
      return failure(
        "INVALID_ARGUMENT",
        "No digest-bound approval is active"
      );
    }
    if (
      this.#selectedSnapshot === "current" ||
      this.#selectedSnapshot === "both"
    ) {
      const current = this.#captureCurrent();
      if (!current.ok) return current;
      const selected = selectSnapshot({
        choice: this.#selectedSnapshot,
        captured: this.#input.capturedBytes,
        current: current.value.bytes
      });
      if (!selected.ok || !selected.value.bytes.equals(this.#selectedBytes)) {
        this.#clearApproval();
        return failure(
          "INTEGRITY_ERROR",
          "Current source changed after approval"
        );
      }
      const identities =
        this.#selectedSnapshot === "current"
          ? current.value.sourceIdentities
          : [
              ...sourceIdentities(this.#input).map((item) => ({
                sourceId: `captured:${item.sourceId}`,
                identity: item.identity
              })),
              ...current.value.sourceIdentities.map((item) => ({
                sourceId: `current:${item.sourceId}`,
                identity: item.identity
              }))
            ];
      if (
        canonicalJsonDigest(identities) !==
        canonicalJsonDigest(this.#selectedSourceIdentities)
      ) {
        this.#clearApproval();
        return failure(
          "INTEGRITY_ERROR",
          "Current source identity changed after approval"
        );
      }
    }
    const valid = validateApproval({
      subject: this.#subject,
      approval: this.#approval,
      payload: this.#selectedBytes
    });
    if (!valid.ok) return valid;
    return success({
      bytes: Buffer.from(this.#selectedBytes),
      subject: this.#subject,
      approval: this.#approval,
      evidenceFacts: [...this.#gatheredFacts],
      authorityToken: this.#authorityToken
    });
  }

  view(): ReviewViewModel {
    const gaps = obligations(
      this.#input,
      this.#gatheredFacts,
      this.#retrievalReceipts
    ).filter(
      (obligation) => obligation.status !== "satisfied"
    );
    return {
      runId: this.#input.contextPackage.runId,
      summary: {
        originalBytes: this.#input.receipt.originalBytes,
        preparedBytes: this.#input.receipt.preparedBytes,
        originalTokens: this.#input.receipt.originalTokens,
        preparedTokens: this.#input.receipt.preparedTokens,
        tokenReductionPercent: this.#input.receipt.tokenReductionPercent,
        integrity: this.#input.receipt.integrity,
        reconstruction: this.#input.receipt.reconstruction
      },
      sourceDiff: sourceDiff(this.#input),
      evidence: evidenceLines(this.#input),
      transformations: transformationLines(this.#input),
      omissions: this.#input.contextPackage.manifest.omissions,
      gaps,
      conflicts: gaps.filter((gap) =>
        ["ambiguous", "contradicted"].includes(gap.status)
      ),
      security:
        this.#security.findings.length === 0
          ? [
              "No high-confidence local finding; external live send remains blocked until separate authorization",
              "Content telemetry is disabled"
            ]
          : this.#security.findings.map(
              (finding) =>
                `${finding.kind} ${finding.sourceId} [${finding.startByte},${finding.endByte}) ${finding.redactedPreview}`
            ),
      modelAdvice: ["Current target remains selected until explicit change"],
      target: this.#target,
      selectedSnapshot: this.#selectedSnapshot,
      selectedPayloadSha256: sha256Base64Url(this.#selectedBytes),
      ...(this.#approval === undefined ? {} : { approval: this.#approval }),
      status: this.#status
    };
  }
}

function printView(view: ReviewViewModel, write: (value: string) => void): void {
  write(
    `\nContext Overflow Review ${view.runId}\n` +
      `Tokens ${view.summary.originalTokens} -> ${view.summary.preparedTokens} (${view.summary.tokenReductionPercent.toFixed(2)}%)\n` +
      `Evidence ${view.evidence.length}, transforms ${view.transformations.length}, omissions ${view.omissions.length}, gaps ${view.gaps.length}\n` +
      `Target ${view.target.adapterId} model=${view.target.modelId ?? "current"} session=${view.target.sessionId ?? "new"}\n` +
      `Permissions ${JSON.stringify(view.target.permissions)}\n` +
      `Status ${view.status}; selected ${view.selectedSnapshot} ${view.selectedPayloadSha256}\n`
  );
}

export interface TerminalReviewIo {
  question(prompt: string): Promise<string>;
  write(value: string | Uint8Array): void;
  close(): void;
}

export async function runTerminalReview(
  controller: TerminalReviewController,
  providedIo?: TerminalReviewIo
): Promise<Result<ApprovedReviewPayload | undefined>> {
  const terminal =
    providedIo === undefined ? createInterface({ input, output }) : undefined;
  const io: TerminalReviewIo =
    providedIo ?? {
      question: (prompt) =>
        (terminal as NonNullable<typeof terminal>).question(prompt),
      write: (value) => output.write(value),
      close: () => (terminal as NonNullable<typeof terminal>).close()
    };
  try {
    while (true) {
      const view = controller.view();
      printView(view, (value) => io.write(value));
      const answer = (
        await io.question(
          "Command [approve/approve-selected/approve-merged/original/gather/snapshot <captured|current|both>/diff/evidence/gaps/conflicts/security/model/omissions/retrieve <handle>/edit <text>/target <adapter> <model|-> <session|-> <permissions>/reject/cancel]: "
        )
      ).trim();
      if (answer === "approve") {
        const result = controller.dispatch({ type: "approve-prepared" });
        if (!result.ok) return result;
        return controller.approvedPayload();
      }
      if (answer === "approve-selected") {
        const result = controller.dispatch({ type: "approve-selected" });
        if (!result.ok) return result;
        return controller.approvedPayload();
      }
      if (answer === "original") {
        const result = controller.dispatch({ type: "keep-original" });
        if (!result.ok) return result;
        return controller.approvedPayload();
      }
      if (answer === "approve-merged") {
        const result = controller.dispatch({ type: "approve-merged" });
        if (!result.ok) return result;
        return controller.approvedPayload();
      }
      if (answer === "gather") {
        const gathered = await controller.gatherEvidence();
        if (!gathered.ok) return gathered;
        continue;
      }
      if (answer === "diff") {
        io.write(`${view.sourceDiff.join("\n")}\n`);
        continue;
      }
      if (answer === "evidence") {
        io.write(`${view.evidence.join("\n")}\n`);
        continue;
      }
      if (answer === "gaps") {
        io.write(
          `${view.gaps
            .map((gap) => `${gap.status} ${gap.kind}: ${gap.description}`)
            .join("\n")}\n`
        );
        continue;
      }
      if (answer === "conflicts") {
        io.write(
          `${view.conflicts
            .map((gap) => `${gap.status} ${gap.kind}: ${gap.description}`)
            .join("\n")}\n`
        );
        continue;
      }
      if (answer === "security") {
        io.write(`${view.security.join("\n")}\n`);
        continue;
      }
      if (answer === "model") {
        io.write(`${view.modelAdvice.join("\n")}\n`);
        continue;
      }
      if (answer === "omissions") {
        io.write(
          `${view.omissions
            .map((omission) => `${omission.handle} ${omission.byteLength} bytes`)
            .join("\n")}\n`
        );
        continue;
      }
      if (answer.startsWith("retrieve ")) {
        const retrieved = controller.dispatch({
          type: "retrieve",
          handle: answer.slice("retrieve ".length).trim()
        });
        if (!retrieved.ok) return retrieved;
        io.write(retrieved.value as Buffer);
        io.write("\n");
        continue;
      }
      if (answer.startsWith("edit ")) {
        controller.dispatch({
          type: "edit-result",
          bytes: Buffer.from(answer.slice("edit ".length), "utf8")
        });
        continue;
      }
      if (answer.startsWith("snapshot ")) {
        const choice = answer.slice("snapshot ".length).trim();
        if (!["captured", "current", "both"].includes(choice)) {
          return failure("INVALID_ARGUMENT", "Unsupported snapshot choice", {
            choice
          });
        }
        const selected = controller.dispatch({
          type: "choose-snapshot",
          choice: choice as "captured" | "current" | "both"
        });
        if (!selected.ok) return selected;
        continue;
      }
      if (answer.startsWith("target ")) {
        const [adapterId, modelId, sessionId, permissionText] = answer
          .slice("target ".length)
          .trim()
          .split(/\s+/, 4);
        if (adapterId === undefined) {
          return failure("INVALID_ARGUMENT", "Target adapter is required");
        }
        const permissions = new Set(
          (permissionText ?? "source,evidence").split(",")
        );
        const selected = controller.dispatch({
          type: "set-target",
          target: {
            adapterId,
            ...(modelId === undefined || modelId === "-"
              ? {}
              : { modelId }),
            ...(sessionId === undefined || sessionId === "-"
              ? {}
              : { sessionId }),
            workingDirectory: view.target.workingDirectory,
            permissions: {
              sourceRead: permissions.has("source"),
              evidenceRead: permissions.has("evidence"),
              fileWrite: permissions.has("write"),
              shell: permissions.has("shell"),
              network: permissions.has("network")
            }
          }
        });
        if (!selected.ok) return selected;
        continue;
      }
      if (answer === "reject") {
        controller.dispatch({ type: "reject" });
        return success(undefined);
      }
      if (answer === "cancel") {
        controller.dispatch({ type: "cancel" });
        return success(undefined);
      }
    }
  } finally {
    if (providedIo === undefined) terminal?.close();
    else io.close();
  }
}
