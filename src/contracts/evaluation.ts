import type { ProducerMetadata } from "./providers.js";

export type EvaluationArm = "original" | "prepared" | "truncation";

export interface EvaluationCase {
  readonly caseId: string;
  readonly title: string;
  readonly prompt: string;
  readonly artifactPaths: readonly string[];
  readonly expectedEvidenceIds: readonly string[];
  readonly expectedFailureIds: readonly string[];
  readonly expectedCitations: readonly string[];
  readonly allowAbstention: boolean;
  readonly source: "neutral" | "held-out" | "external";
}

export interface EvaluationRunSettings {
  readonly modelId: string;
  readonly reasoningEffort?: string;
  readonly contextTier?: string;
  readonly permissionDigest: string;
  readonly adapterId: string;
}

export interface EvaluationTrialPlan {
  readonly trialId: string;
  readonly caseId: string;
  readonly trialNumber: number;
  readonly arm: EvaluationArm;
  readonly settings: EvaluationRunSettings;
  readonly sessionConstraintDigest: string;
}

export interface EvaluationReplayManifest {
  readonly formatVersion: 1;
  readonly suiteId: string;
  readonly seed: number;
  readonly liveOptIn: boolean;
  readonly trialsPerArm: number;
  readonly cases: readonly EvaluationCase[];
  readonly plans: readonly EvaluationTrialPlan[];
  readonly createdAt: string;
  readonly producer: ProducerMetadata;
  readonly digest: string;
}

export interface EvaluationObservation {
  readonly trialId: string;
  readonly caseId: string;
  readonly arm: EvaluationArm;
  readonly modelId: string;
  readonly settingsDigest: string;
  readonly sessionConstraintDigest: string;
  readonly taskSuccess: boolean;
  readonly visibleEvidenceIds: readonly string[];
  readonly recoverableEvidenceIds: readonly string[];
  readonly distinctFailureIds: readonly string[];
  readonly citations: readonly string[];
  readonly unsupportedClaims: number;
  readonly contradictions: number;
  readonly abstained: boolean;
  readonly retrievalTokens: number;
  readonly retrievalCalls: number;
  readonly retrievalLatencyMs: number;
  readonly preparationLatencyMs: number;
  readonly reviewLatencyMs: number;
  readonly handoffLatencyMs: number;
  readonly modelLatencyMs: number;
  readonly decisions: number;
  readonly tools: number;
  readonly permissions: number;
  readonly execution: {
    readonly adapterProducerId: string;
    readonly executableDigest: string;
    readonly protocolDigest: string;
    readonly actualModelId: string;
    readonly actualSettingsDigest: string;
    readonly sessionId: string;
    readonly newSession: true;
  };
  readonly aaPairId?: string;
  readonly aaVariant?: "A1" | "A2";
}

export interface EvaluationScore {
  readonly trialId: string;
  readonly caseId: string;
  readonly arm: EvaluationArm;
  readonly taskSuccess: number;
  readonly visibleEvidenceRecall: number;
  readonly recoverableEvidenceRecall: number;
  readonly distinctFailureRecall: number;
  readonly citationRecall: number;
  readonly unsupportedClaims: number;
  readonly contradictions: number;
  readonly abstentionScore: number;
  readonly totalLatencyMs: number;
  readonly retrievalTokens: number;
  readonly retrievalCalls: number;
  readonly decisions: number;
  readonly tools: number;
  readonly permissions: number;
}

export interface PairedEvaluationReport {
  readonly manifestDigest: string;
  readonly scores: readonly EvaluationScore[];
  readonly originalMean: number;
  readonly preparedMean: number;
  readonly meanDifference: number;
  readonly effectSizeDz: number | null;
  readonly bootstrap95: readonly [number, number];
  readonly discordance: {
    readonly preparedWins: number;
    readonly originalWins: number;
    readonly ties: number;
  };
  readonly aaNoise?: number;
  readonly reportingFloorMet: boolean;
  readonly warnings: readonly string[];
  readonly producer: ProducerMetadata;
}
