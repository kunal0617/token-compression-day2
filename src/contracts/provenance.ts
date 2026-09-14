import type { ProducerMetadata } from "./providers.js";

export interface GitObjectIdentity {
  readonly repositoryRoot: string;
  readonly commit: string;
  readonly tree: string;
  readonly blob: string;
  readonly path: string;
  readonly mode: string;
  readonly worktreeMatchesBlob: boolean;
}

export interface SourceSnapshotIdentity {
  readonly sha256: string;
  readonly byteLength: number;
  readonly git?: GitObjectIdentity;
}

export interface ApprovedSourceCandidate {
  readonly candidateId: string;
  readonly label: string;
  readonly canonicalPath?: string;
  readonly approved: boolean;
  readonly bytes: Buffer;
  readonly identity: SourceSnapshotIdentity;
}

export interface ExactSourceOccurrence {
  readonly occurrenceId: string;
  readonly candidateId: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly candidateIdentity: SourceSnapshotIdentity;
}

export interface SourceProvenanceResult {
  readonly state: "no-match" | "unique" | "ambiguous";
  readonly querySha256: string;
  readonly queryByteLength: number;
  readonly occurrences: readonly ExactSourceOccurrence[];
  readonly producer: ProducerMetadata;
  readonly authoritative: true;
}

export interface SourceLink {
  readonly occurrenceId: string;
  readonly candidateId: string;
  readonly label: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly sha256: string;
  readonly git?: GitObjectIdentity;
  readonly rendered: string;
}

