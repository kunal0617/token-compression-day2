import type { Result } from "../core/result.js";
import type { ProducerMetadata } from "./providers.js";

export interface ByteRange {
  startByte: number;
  endByte: number;
}

export type ArtifactRole = "prompt" | "context";
export type SourceKind = "file" | "pasted";
export type NewlineStyle = "none" | "lf" | "crlf" | "cr" | "mixed";
export type Utf8Status = "valid" | "invalid";

export interface ArtifactSource {
  readonly kind: SourceKind;
  readonly label: string;
  readonly requestedPath?: string;
  readonly canonicalPath?: string;
}

export interface ArtifactSnapshot {
  readonly artifactId: string;
  readonly ordinal: number;
  readonly role: ArtifactRole;
  readonly source: ArtifactSource;
  readonly bytes: Buffer;
  readonly byteLength: number;
  readonly sha256: string;
  readonly utf8: Utf8Status;
  readonly hasBom: boolean;
  readonly newlineStyle: NewlineStyle;
  readonly hasAnsi: boolean;
  readonly completeness: "complete" | "truncated" | "unknown";
  readonly completenessReason: string;
}

export type ArtifactKind =
  | "prompt"
  | "test-log"
  | "compiler-diagnostics"
  | "stack-trace"
  | "diff"
  | "source"
  | "generic-log"
  | "text";

export interface ArtifactClassification {
  readonly artifactId: string;
  readonly kind: ArtifactKind;
  readonly confidence: number;
  readonly uncertain: boolean;
  readonly reasons: readonly string[];
}

export type IntentKind =
  | "debug"
  | "fix"
  | "build"
  | "test"
  | "review"
  | "explain"
  | "general";

export interface IntentClassification {
  readonly kind: IntentKind;
  readonly confidence: number;
  readonly uncertain: boolean;
  readonly reasons: readonly string[];
}

export type EvidenceKind =
  | "failing-test"
  | "assertion-block"
  | "expected-value"
  | "actual-value"
  | "exception-chain"
  | "exception"
  | "stack-frame"
  | "compiler-diagnostic"
  | "command"
  | "exit-code"
  | "source-location"
  | "path"
  | "identifier"
  | "version"
  | "timestamp"
  | "final-summary"
  | "correlation-id"
  | "ci-critical"
  | "unknown-diagnostic";

export interface EvidenceSpan extends ByteRange {
  readonly evidenceId: string;
  readonly occurrenceId: string;
  readonly artifactId: string;
  readonly kind: EvidenceKind;
  readonly sha256: string;
  readonly textPreview: string;
  readonly reasons: readonly string[];
  readonly mandatoryInline: boolean;
  readonly protectionReasons: readonly string[];
}

export type SegmentKind =
  | "blank"
  | "command"
  | "diagnostic"
  | "diff"
  | "stack"
  | "summary"
  | "success"
  | "progress"
  | "boilerplate"
  | "text";

export interface Segment extends ByteRange {
  readonly segmentId: string;
  readonly artifactId: string;
  readonly ordinal: number;
  readonly kind: SegmentKind;
  readonly sha256: string;
}

export interface ProtectedRange extends ByteRange {
  readonly artifactId: string;
  readonly reasons: readonly string[];
  readonly evidenceIds: readonly string[];
}

export type RunOutcome = "green" | "red" | "unknown";

export type TransformReason =
  | "exact-consecutive-repetition"
  | "exact-nonconsecutive-repetition"
  | "success-chatter"
  | "scoped-boilerplate"
  | "volatile-template"
  | "ci-wrapper";

export interface TransformProposal extends ByteRange {
  readonly proposalId: string;
  readonly artifactId: string;
  readonly reason: TransformReason;
  readonly priority: number;
  readonly sourceCount: number;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export interface PlannedTransform extends TransformProposal {
  readonly occurrenceId: string;
  readonly omittedSha256: string;
  readonly omittedByteLength: number;
  readonly handle: string;
  readonly marker: string;
}

export type OutputMappingKind = "synthetic" | "literal" | "omission";

export interface OutputMapping {
  readonly mappingId: string;
  readonly ordinal: number;
  readonly artifactId?: string;
  readonly sourceStartByte?: number;
  readonly sourceEndByte?: number;
  readonly outputStartByte: number;
  readonly outputEndByte: number;
  readonly kind: OutputMappingKind;
  readonly handle?: string;
}

export interface EvidenceOutputMapping {
  readonly evidenceId: string;
  readonly occurrenceId: string;
  readonly artifactId: string;
  readonly sourceStartByte: number;
  readonly sourceEndByte: number;
  readonly outputStartByte: number;
  readonly outputEndByte: number;
  readonly sha256: string;
}

export interface OmissionRecord extends ByteRange {
  readonly occurrenceId: string;
  readonly artifactId: string;
  readonly handle: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly reason: TransformReason;
  readonly marker: string;
  readonly sourceCount: number;
}

export interface ArtifactManifest {
  readonly artifactId: string;
  readonly ordinal: number;
  readonly role: ArtifactRole;
  readonly source: ArtifactSource;
  readonly byteLength: number;
  readonly sha256: string;
  readonly utf8: Utf8Status;
  readonly hasBom: boolean;
  readonly newlineStyle: NewlineStyle;
  readonly hasAnsi: boolean;
  readonly completeness: "complete" | "truncated" | "unknown";
  readonly completenessReason: string;
  readonly outcome: RunOutcome;
  readonly classification: ArtifactClassification;
}

export interface CanonicalManifest {
  readonly formatVersion: 1 | 2;
  readonly runId: string;
  readonly createdAt: string;
  readonly artifacts: readonly ArtifactManifest[];
  readonly intent: IntentClassification;
  readonly outcome: RunOutcome;
  readonly policy: {
    readonly nearbySegments: number;
  };
  readonly producerRegistry?: {
    readonly digest: string;
    readonly producers: readonly ProducerMetadata[];
  };
  readonly evidence: readonly EvidenceSpan[];
  readonly protectedRanges: readonly ProtectedRange[];
  readonly transforms: readonly PlannedTransform[];
  readonly omissions: readonly OmissionRecord[];
  readonly outputMappings: readonly OutputMapping[];
  readonly evidenceMappings: readonly EvidenceOutputMapping[];
  readonly compactSha256: string;
  readonly compactByteLength: number;
  readonly originalByteLength: number;
  readonly tokenizer: TokenMeasurement;
}

export interface TokenMeasurement {
  readonly encoding: "o200k_base";
  readonly kind: "actual";
  readonly originalTokens: number;
  readonly preparedTokens: number;
}

export interface ContextPackage {
  readonly runId: string;
  readonly preparedBytes: Buffer;
  readonly preparedText: string;
  readonly manifest: CanonicalManifest;
  readonly manifestJson: string;
  readonly manifestSha256: string;
}

export interface ValidatedContextPackage extends ContextPackage {
  readonly validation: {
    readonly status: "validated";
    readonly reconstruction: "byte-identical";
    readonly committed: true;
  };
}

export interface ContextReceipt {
  readonly runId: string;
  readonly readiness: "ready" | "failed";
  readonly artifactClassifications: readonly ArtifactClassification[];
  readonly intent: IntentClassification;
  readonly outcome: RunOutcome;
  readonly originalBytes: number;
  readonly preparedBytes: number;
  readonly originalTokens: number;
  readonly preparedTokens: number;
  readonly tokenReductionPercent: number;
  readonly protectedEvidence: readonly {
    evidenceId: string;
    occurrenceId: string;
    kind: EvidenceKind;
    artifactId: string;
    startByte: number;
    endByte: number;
  }[];
  readonly transformations: Readonly<Record<TransformReason, number>>;
  readonly handles: readonly string[];
  readonly warnings: readonly string[];
  readonly integrity: "verified";
  readonly reconstruction: "byte-identical";
}

export interface PrepareSuccess {
  readonly package: ValidatedContextPackage;
  readonly receipt: ContextReceipt;
}

export type PrepareResult = Result<PrepareSuccess>;

export interface HandoffReceipt {
  readonly accepted: true;
  readonly runId: string;
}

export interface CodingAgentHandoffPort {
  handoff(contextPackage: ValidatedContextPackage): Promise<Result<HandoffReceipt>>;
}
