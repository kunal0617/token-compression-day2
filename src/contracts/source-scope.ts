import type { ProducerMetadata } from "./providers.js";
import type { SourceSnapshotIdentity } from "./provenance.js";

export type SourceLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "other";

export interface SourceDocument {
  readonly sourceId: string;
  readonly path: string;
  readonly language: SourceLanguage;
  readonly bytes: Buffer;
  readonly identity: SourceSnapshotIdentity;
}

export type CodeUnitKind =
  | "file"
  | "import"
  | "function"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "method"
  | "test"
  | "export";

export interface CodeUnit {
  readonly unitId: string;
  readonly sourceId: string;
  readonly kind: CodeUnitKind;
  readonly name?: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly sha256: string;
  readonly producer: ProducerMetadata;
}

export type SemanticEdgeKind =
  | "import"
  | "definition"
  | "type"
  | "test";

export interface SemanticEdge {
  readonly edgeId: string;
  readonly kind: SemanticEdgeKind;
  readonly fromSourceId: string;
  readonly fromStartByte: number;
  readonly fromEndByte: number;
  readonly toSourceId: string;
  readonly toStartByte: number;
  readonly toEndByte: number;
  readonly symbol?: string;
  readonly producer: ProducerMetadata;
}

export interface DeliveryRoot {
  readonly sourceId: string;
  readonly startByte?: number;
  readonly endByte?: number;
  readonly symbol?: string;
}

export interface DeliveryRules {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly includeImports: boolean;
  readonly includeDefinitions: boolean;
  readonly includeTypes: boolean;
  readonly includeTests: boolean;
}

export interface DeliverySlice {
  readonly sourceId: string;
  readonly path: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly unitIds: readonly string[];
}

export interface DeliveryPlan {
  readonly roots: readonly DeliveryRoot[];
  readonly rules: DeliveryRules;
  readonly slices: readonly DeliverySlice[];
  readonly edges: readonly SemanticEdge[];
  readonly omittedSourceIds: readonly string[];
  readonly totalBytes: number;
  readonly warnings: readonly string[];
  readonly producers: readonly ProducerMetadata[];
}

export interface SourceStructureRequest {
  readonly document: SourceDocument;
}

export interface SemanticEdgeRequest {
  readonly documents: readonly SourceDocument[];
}

export interface LspSemanticPort {
  readonly metadata: ProducerMetadata;
  edges(request: SemanticEdgeRequest): Promise<readonly SemanticEdge[]>;
}

