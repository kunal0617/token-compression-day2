import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import type {
  ApprovedReviewPayload,
  ReviewAction,
  ReviewViewModel,
  TerminalReviewInput
} from "../contracts/tui.js";
import type { ApprovalRecord, ReviewSubject } from "../contracts/approval.js";
import type { EvidenceObligation } from "../contracts/providers.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import { sha256Base64Url } from "../core/hash.js";
import { failure, success, type Result } from "../core/result.js";
import {
  approveReviewSubject,
  reviewSubjectProvider,
  selectSnapshot,
  validateApproval
} from "../approval/review.js";
import { assessFailureEvidence } from "../obligations/evaluate.js";
import { builtinRuntime } from "../registry/builtins.js";

export interface ReviewRetrievalPort {
  retrieve(handle: string): Result<Buffer>;
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

function obligations(input: TerminalReviewInput): readonly EvidenceObligation[] {
  const results: EvidenceObligation[] = [];
  for (const artifact of input.artifacts) {
    const assessed = assessFailureEvidence({
      artifact,
      evidence: input.contextPackage.manifest.evidence.filter(
        (evidence) => evidence.artifactId === artifact.artifactId
      )
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
  #selectedSnapshot: ReviewViewModel["selectedSnapshot"] = "captured";
  #subject: ReviewSubject | undefined;
  #approval: ApprovalRecord | undefined;
  #status: ReviewViewModel["status"] = "reviewing";

  constructor(input: TerminalReviewInput, retrieval: ReviewRetrievalPort) {
    this.#input = input;
    this.#retrieval = retrieval;
    this.#target = input.target;
    this.#selectedBytes = Buffer.from(input.contextPackage.preparedBytes);
  }

  #clearApproval(): void {
    this.#subject = undefined;
    this.#approval = undefined;
    if (this.#status === "approved") this.#status = "reviewing";
  }

  #approve(decision: "approve-prepared" | "keep-original" | "approve-merged"): Result<void> {
    const gaps = this.view().gaps;
    if (gaps.length > 0) {
      return failure(
        "INVALID_ARGUMENT",
        "Gather More Evidence must resolve blocking obligations before approval",
        { obligations: gaps.map((gap) => gap.obligationId) }
      );
    }
    const subject = reviewSubjectProvider.provide({
      runId: this.#input.contextPackage.runId,
      payload: this.#selectedBytes,
      sourceIdentities: sourceIdentities(this.#input),
      policyDigest: canonicalJsonDigest(
        this.#input.contextPackage.manifest.policy
      ),
      detectorRegistryDigest:
        this.#input.contextPackage.manifest.producerRegistry?.digest ??
        builtinRuntime.registryDigest,
      tokenizer: this.#input.contextPackage.manifest.tokenizer.encoding,
      target: this.#target,
      snapshotChoice: this.#selectedSnapshot
    });
    if (!subject.ok) return subject;
    const approval = approveReviewSubject({
      subject: subject.value,
      payload: this.#selectedBytes,
      decision
    });
    if (!approval.ok) return approval;
    this.#subject = subject.value;
    this.#approval = approval.value;
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
      this.#clearApproval();
      return success(undefined);
    }
    if (action.type === "choose-snapshot") {
      const selected = selectSnapshot({
        choice: action.choice,
        captured: this.#input.contextPackage.preparedBytes,
        current: this.#input.originalBytes,
        ...(action.choice === "editable-merge"
          ? { editedMerge: this.#selectedBytes }
          : {})
      });
      if (!selected.ok) return selected;
      this.#selectedBytes = selected.value.bytes;
      this.#selectedSnapshot = action.choice;
      this.#clearApproval();
      return success(undefined);
    }
    if (action.type === "approve-prepared") {
      this.#selectedBytes = Buffer.from(
        this.#input.contextPackage.preparedBytes
      );
      this.#selectedSnapshot = "captured";
      return this.#approve("approve-prepared");
    }
    if (action.type === "keep-original") {
      this.#selectedBytes = Buffer.from(this.#input.originalBytes);
      this.#selectedSnapshot = "current";
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

  approvedPayload(): Result<ApprovedReviewPayload> {
    if (this.#subject === undefined || this.#approval === undefined) {
      return failure(
        "INVALID_ARGUMENT",
        "No digest-bound approval is active"
      );
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
      approval: this.#approval
    });
  }

  view(): ReviewViewModel {
    const gaps = obligations(this.#input).filter(
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
      security: ["Local-only review; live send remains blocked until approval"],
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
          "Command [approve/approve-merged/original/gather/snapshot <captured|current|both>/diff/evidence/gaps/conflicts/security/model/omissions/retrieve <handle>/edit <text>/target <adapter> <model|-> <session|-> <permissions>/reject/cancel]: "
        )
      ).trim();
      if (answer === "approve") {
        const result = controller.dispatch({ type: "approve-prepared" });
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
        controller.dispatch({ type: "gather-evidence" });
        return success(undefined);
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
