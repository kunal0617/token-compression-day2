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
import type { AgentReadScope } from "./agent.js";
import type { EvidenceFact } from "./obligations.js";
import type { SourceSnapshotIdentity } from "./provenance.js";
import type { Result } from "../core/result.js";

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
  | { readonly type: "approve-selected" }
  | { readonly type: "keep-original" }
  | { readonly type: "approve-merged" }
  | { readonly type: "gather-evidence" }
  | { readonly type: "retrieve"; readonly handle: string }
  | {
      readonly type: "choose-snapshot";
      readonly choice: Exclude<SnapshotChoice, "cancel">;
    }
  | { readonly type: "edit-result"; readonly bytes: Buffer }
  | { readonly type: "add-evidence-facts"; readonly facts: readonly EvidenceFact[] }
  | { readonly type: "set-target"; readonly target: ApprovalTarget }
  | { readonly type: "reject" }
  | { readonly type: "cancel" };

export interface TerminalReviewInput {
  readonly contextPackage: ValidatedContextPackage;
  readonly receipt: ContextReceipt;
  readonly capturedBytes: Buffer;
  readonly artifacts: readonly ArtifactSnapshot[];
  readonly readScope: AgentReadScope;
  readonly gatheredFacts?: readonly EvidenceFact[];
  readonly currentSource?: CurrentSourceReadPort;
  readonly target: ApprovalTarget;
}

export interface CurrentSnapshotCapture {
  readonly bytes: Buffer;
  readonly sourceIdentities: readonly {
    readonly sourceId: string;
    readonly identity: SourceSnapshotIdentity;
  }[];
}

export interface CurrentSourceReadPort {
  capture(): Result<CurrentSnapshotCapture>;
}

export interface ApprovedReviewPayload {
  readonly bytes: Buffer;
  readonly subject: ReviewSubject;
  readonly approval: ApprovalRecord;
}
