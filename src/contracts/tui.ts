import type {
  ApprovalRecord,
  ApprovalTarget,
  ReviewSubject,
  SnapshotChoice
} from "./approval.js";
import type {
  ArtifactSnapshot,
  ContextReceipt,
  OmissionRecord,
  ValidatedContextPackage
} from "./types.js";
import type { EvidenceObligation } from "./providers.js";

export interface ReviewViewModel {
  readonly runId: string;
  readonly summary: {
    readonly originalBytes: number;
    readonly preparedBytes: number;
    readonly originalTokens: number;
    readonly preparedTokens: number;
    readonly tokenReductionPercent: number;
    readonly integrity: string;
    readonly reconstruction: string;
  };
  readonly sourceDiff: readonly string[];
  readonly evidence: readonly string[];
  readonly transformations: readonly string[];
  readonly omissions: readonly OmissionRecord[];
  readonly gaps: readonly EvidenceObligation[];
  readonly conflicts: readonly EvidenceObligation[];
  readonly security: readonly string[];
  readonly modelAdvice: readonly string[];
  readonly target: ApprovalTarget;
  readonly selectedSnapshot: SnapshotChoice;
  readonly selectedPayloadSha256: string;
  readonly approval?: ApprovalRecord;
  readonly status:
    | "reviewing"
    | "approved"
    | "gather-evidence"
    | "rejected"
    | "cancelled";
}

export type ReviewAction =
  | { readonly type: "approve-prepared" }
  | { readonly type: "keep-original" }
  | { readonly type: "approve-merged" }
  | { readonly type: "gather-evidence" }
  | { readonly type: "retrieve"; readonly handle: string }
  | {
      readonly type: "choose-snapshot";
      readonly choice: Exclude<SnapshotChoice, "cancel">;
    }
  | { readonly type: "edit-result"; readonly bytes: Buffer }
  | { readonly type: "set-target"; readonly target: ApprovalTarget }
  | { readonly type: "reject" }
  | { readonly type: "cancel" };

export interface TerminalReviewInput {
  readonly contextPackage: ValidatedContextPackage;
  readonly receipt: ContextReceipt;
  readonly originalBytes: Buffer;
  readonly artifacts: readonly ArtifactSnapshot[];
  readonly target: ApprovalTarget;
}

export interface ApprovedReviewPayload {
  readonly bytes: Buffer;
  readonly subject: ReviewSubject;
  readonly approval: ApprovalRecord;
}
