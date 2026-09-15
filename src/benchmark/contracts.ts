import type { ContextReceipt } from "../contracts/types.js";
import type { EvaluationArm } from "../contracts/evaluation.js";

export const benchmarkCaseIds = [
  "cq01",
  "cq02",
  "cq03-incomplete",
  "cq03-complete",
  "cq04",
  "cq05",
  "cq06-missing",
  "cq06-observed",
  "cq07",
  "mf01",
  "mf02",
  "mf03",
  "luna"
] as const;

export type BenchmarkCaseId = (typeof benchmarkCaseIds)[number];

export type BenchmarkCaseKind =
  | "paired"
  | "deterministic-abstention"
  | "model-fit"
  | "helper";

export interface BenchmarkFact {
  readonly factId: string;
  readonly label: string;
  readonly value: string;
  readonly valueSha256: string;
  readonly kind:
    | "evidence"
    | "failure"
    | "citation"
    | "expected"
    | "actual"
    | "source"
    | "configuration";
  readonly required: boolean;
}

export interface BenchmarkCaseContract {
  readonly caseId: BenchmarkCaseId;
  readonly contract: string;
  readonly kind: BenchmarkCaseKind;
  readonly prompt: string;
  readonly requiredFacts: readonly BenchmarkFact[];
  readonly allowAbstention: boolean;
  readonly deterministicAdvice?: Readonly<Record<string, unknown>>;
  readonly digest: string;
}

export interface BenchmarkFileIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface BenchmarkExportCase {
  readonly caseId: BenchmarkCaseId;
  readonly contract: string;
  readonly kind: BenchmarkCaseKind;
  readonly runId: string;
  readonly storePath: string;
  readonly store: BenchmarkFileIdentity;
  readonly original: BenchmarkFileIdentity;
  readonly prepared: BenchmarkFileIdentity;
  readonly receipt: BenchmarkFileIdentity;
  readonly contractFile: BenchmarkFileIdentity;
  readonly manifestSha256: string;
  readonly readiness: ContextReceipt["readiness"];
  readonly preparationLatencyMs: number;
  readonly deterministicAdviceDigest?: string;
  readonly digest: string;
}

export interface BenchmarkSuite {
  readonly formatVersion: 1;
  readonly suiteId: string;
  readonly createdAt: string;
  readonly sourceRootDigest: string;
  readonly selectedCases: readonly BenchmarkCaseId[];
  readonly cases: readonly BenchmarkExportCase[];
  readonly producerDigest: string;
  readonly digest: string;
}

export type BenchmarkTrialArm = EvaluationArm | "task" | "helper";

export interface BenchmarkModelBlock {
  readonly modelId: string;
  readonly settingsDigest: string;
  readonly permissionDigest: string;
  readonly adapterId: string;
  readonly executableDigest: string;
  readonly protocolDigest: string;
}

export interface BenchmarkTrialPlan {
  readonly trialId: string;
  readonly caseId: BenchmarkCaseId;
  readonly modelId: string;
  readonly trialNumber: number;
  readonly arm: BenchmarkTrialArm;
  readonly payloadPath?: string;
  readonly payloadSha256?: string;
  readonly deterministicAbstention: boolean;
  readonly helper: boolean;
  readonly settingsDigest: string;
  readonly permissionDigest: string;
  readonly pairDigest: string;
}

export interface BenchmarkReplayManifest {
  readonly formatVersion: 1;
  readonly benchmarkRunId: string;
  readonly suiteId: string;
  readonly suiteDigest: string;
  readonly sourceRootDigest: string;
  readonly seed: number;
  readonly trials: number;
  readonly liveOptIn: boolean;
  readonly selectedCases: readonly BenchmarkCaseId[];
  readonly modelBlocks: readonly BenchmarkModelBlock[];
  readonly helperModelId?: string;
  readonly plans: readonly BenchmarkTrialPlan[];
  readonly estimatedCallCount: number;
  readonly createdAt: string;
  readonly digest: string;
}

export type BenchmarkTrialStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "interrupted"
  | "blocked"
  | "not-applicable";

export interface BenchmarkExecutionReceipt {
  readonly adapterProducerId: string;
  readonly adapterProducerDigest: string;
  readonly executableDigest: string;
  readonly protocolDigest: string;
  readonly actualModelId: string;
  readonly actualSettingsDigest: string;
  readonly sessionId: string;
  readonly newSession: true;
  readonly payloadSha256: string;
  readonly eventCount: number;
  readonly modelLatencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolOutcomes: number;
  readonly permissionOutcomes: number;
}

export interface BenchmarkTrialRecord {
  readonly trialId: string;
  readonly status: BenchmarkTrialStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly sent: boolean;
  readonly abstained: boolean;
  readonly responsePath?: string;
  readonly responseSha256?: string;
  readonly responseByteLength?: number;
  readonly securityAssessmentDigest?: string;
  readonly execution?: BenchmarkExecutionReceipt;
  readonly observation?: {
    readonly taskSuccess: boolean;
    readonly visibleFactIds: readonly string[];
    readonly recoverableFactIds: readonly string[];
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
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly decisions: number;
    readonly tools: number;
    readonly permissions: number;
  };
  readonly errorCode?: string;
  readonly errorDigest?: string;
  readonly digest: string;
}

export interface BenchmarkRunState {
  readonly formatVersion: 1;
  readonly benchmarkRunId: string;
  readonly suitePath: string;
  readonly manifest: BenchmarkReplayManifest;
  readonly manifestApprovalDigest?: string;
  readonly status:
    | "planned"
    | "running"
    | "completed"
    | "completed-with-failures";
  readonly trials: Readonly<Record<string, BenchmarkTrialRecord>>;
  readonly updatedAt: string;
  readonly digest: string;
}

export interface BenchmarkTrialScore {
  readonly trialId: string;
  readonly caseId: BenchmarkCaseId;
  readonly modelId: string;
  readonly arm: BenchmarkTrialArm;
  readonly trialNumber: number;
  readonly taskSuccess: number;
  readonly visibleEvidenceRecall: number;
  readonly recoverableEvidenceRecall: number;
  readonly distinctFailureRecall: number;
  readonly citationRecall: number;
  readonly unsupportedClaims: number;
  readonly contradictions: number;
  readonly abstentionScore: number;
  readonly retrievalTokens: number;
  readonly retrievalCalls: number;
  readonly retrievalLatencyMs: number;
  readonly preparationLatencyMs: number;
  readonly reviewLatencyMs: number;
  readonly handoffLatencyMs: number;
  readonly modelLatencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly decisions: number;
  readonly tools: number;
  readonly permissions: number;
}

export interface BenchmarkModelReport {
  readonly modelId: string;
  readonly scores: readonly BenchmarkTrialScore[];
  readonly aaSelfAgreement: number | null;
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
  readonly reportingFloorMet: boolean;
  readonly warnings: readonly string[];
}

export interface BenchmarkReport {
  readonly formatVersion: 1;
  readonly benchmarkRunId: string;
  readonly manifestDigest: string;
  readonly suiteDigest: string;
  readonly models: readonly BenchmarkModelReport[];
  readonly detailedRunPath: string;
  readonly contentSafe: true;
  readonly digest: string;
}
