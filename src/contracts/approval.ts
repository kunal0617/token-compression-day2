import type { ProducerMetadata } from "./providers.js";
import type { SourceSnapshotIdentity } from "./provenance.js";

export interface PermissionEnvelope {
  readonly sourceRead: boolean;
  readonly evidenceRead: boolean;
  readonly fileWrite: boolean;
  readonly shell: boolean;
  readonly network: boolean;
}

export interface ApprovalTarget {
  readonly adapterId: string;
  readonly sessionId?: string;
  readonly modelId?: string;
  readonly workingDirectory: string;
  readonly permissions: PermissionEnvelope;
}

export type SnapshotChoice =
  | "captured"
  | "current"
  | "both"
  | "editable-merge"
  | "cancel";

export interface ReviewSubject {
  readonly reviewSubjectId: string;
  readonly runId: string;
  readonly payloadSha256: string;
  readonly payloadByteLength: number;
  readonly sourceIdentities: readonly {
    readonly sourceId: string;
    readonly identity: SourceSnapshotIdentity;
  }[];
  readonly policyDigest: string;
  readonly detectorRegistryDigest: string;
  readonly tokenizer: string;
  readonly target: ApprovalTarget;
  readonly snapshotChoice: SnapshotChoice;
  readonly createdAt: string;
  readonly producer: ProducerMetadata;
  readonly digest: string;
}

export type ApprovalDecision =
  | "approve-prepared"
  | "keep-original"
  | "approve-merged"
  | "reject";

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly runId: string;
  readonly reviewSubjectDigest: string;
  readonly approvedPayloadSha256: string;
  readonly decision: ApprovalDecision;
  readonly approvedAt: string;
  readonly digest: string;
}

export interface SnapshotComparison {
  readonly state: "unchanged" | "changed";
  readonly captured: SourceSnapshotIdentity;
  readonly current: SourceSnapshotIdentity;
}

export interface SnapshotSelection {
  readonly choice: SnapshotChoice;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly requiresFreshApproval: boolean;
}

export interface Diff3MergeResult {
  readonly bytes: Buffer;
  readonly conflicted: boolean;
  readonly requiresFreshApproval: true;
}

