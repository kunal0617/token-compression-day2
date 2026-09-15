import type { ModelCatalogEntry } from "./agent.js";
import type { ProducerMetadata } from "./providers.js";

export type OperationClass =
  | "MF-01-exact-operation"
  | "MF-02-bounded-routine"
  | "MF-03-reasoning-intensive";

export interface CuratedModelPolicyEntry {
  readonly modelId: string;
  readonly allowedOperations: readonly OperationClass[];
  readonly enabled: boolean;
  readonly notes: readonly string[];
}

export interface CuratedModelPolicy {
  readonly version: string;
  readonly entries: readonly CuratedModelPolicyEntry[];
  readonly digest: string;
}

export interface ModelFitRequest {
  readonly operation: OperationClass;
  readonly currentModelId?: string;
  readonly requiredInputTokens: number;
  readonly requiresTools: boolean;
  readonly requiresVision: boolean;
  readonly evidenceDecision: "ready" | "gather-more-evidence";
  readonly catalog: readonly ModelCatalogEntry[];
  readonly policy: CuratedModelPolicy;
}

export interface ModelScore {
  readonly modelId: string;
  readonly eligible: boolean;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface ModelFitAdvice {
  readonly operation: OperationClass;
  readonly decision: "keep-current" | "recommend-new-session";
  readonly currentModelId?: string;
  readonly recommendedModelId?: string;
  readonly requiresNewSession: boolean;
  readonly scores: readonly ModelScore[];
  readonly reasons: readonly string[];
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly producer: ProducerMetadata;
}

