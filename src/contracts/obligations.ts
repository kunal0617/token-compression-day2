import type { FailureReport } from "./failures.js";
import type {
  EvidenceObligation,
  PolicyDecision,
  ProducerMetadata
} from "./providers.js";
import type { EvidenceSpan } from "./types.js";
import type { Result } from "../core/result.js";

export type ObligationKind =
  | "failure-block"
  | "expected-value"
  | "actual-value"
  | "referenced-source"
  | "type-interface"
  | "configuration"
  | "runtime"
  | "external-fact"
  | "command-exit"
  | "final-summary";

export interface EvidenceFact {
  readonly factId: string;
  readonly obligationId: string;
  readonly kind: ObligationKind;
  readonly key: string;
  readonly value: string;
  readonly evidenceIds: readonly string[];
  readonly artifactId: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly sha256: string;
  readonly byteLength: number;
  readonly validationDigest: string;
  readonly origin: "detector-evidence" | "bounded-retrieval";
  readonly retrievalBinding?: {
    readonly receiptId: string;
    readonly requestDigest: string;
    readonly responseDigest: string;
    readonly adapter: ProducerMetadata;
  };
  readonly observedAt?: string;
  readonly contradicts?: boolean;
}

export interface EvidenceObligationSpec {
  readonly obligationId: string;
  readonly kind: ObligationKind;
  readonly description: string;
  readonly key: string;
  readonly required: boolean;
  readonly expectedValue?: string;
  readonly freshnessMs?: number;
  readonly retrieval?: Omit<EvidenceRetrievalRequest, "obligationId">;
}

export interface EvidenceRetrievalRequest {
  readonly obligationId: string;
  readonly adapterId: string;
  readonly artifactId?: string;
  readonly startByte?: number;
  readonly endByte?: number;
  readonly maxBytes: number;
  readonly purpose: string;
}

export interface EvidenceSufficiencyResult {
  readonly obligations: readonly EvidenceObligation[];
  readonly decision: "ready" | "gather-more-evidence";
  readonly retrievalRequests: readonly EvidenceRetrievalRequest[];
  readonly producer: ProducerMetadata;
}

export interface EvidenceRetrievalAdapter {
  readonly metadata: ProducerMetadata;
  retrieve(
    request: EvidenceRetrievalRequest
  ): Promise<Result<readonly EvidenceFact[]>>;
}

export interface EvidenceRetrievalReceipt {
  readonly receiptId: string;
  readonly requestDigest: string;
  readonly responseDigest: string;
  readonly adapter: ProducerMetadata;
  readonly factDigests: readonly string[];
  readonly digest: string;
}

export interface EvidenceRetrievalExecution {
  readonly facts: readonly EvidenceFact[];
  readonly receipts: readonly EvidenceRetrievalReceipt[];
}

export interface ObligationBuildInput {
  readonly reports: readonly FailureReport[];
  readonly evidence: readonly EvidenceSpan[];
}

export interface GatherPolicyResult
  extends PolicyDecision<EvidenceSufficiencyResult> {}
