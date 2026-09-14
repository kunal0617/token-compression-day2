import type {
  ArtifactClassification,
  ArtifactSnapshot,
  CodingAgentHandoffPort,
  EvidenceSpan,
  IntentClassification,
  PlannedTransform,
  ProtectedRange,
  RunOutcome,
  Segment,
  TransformProposal
} from "./types.js";
import type { Result } from "../core/result.js";

export type ProducerKind =
  | "feature-provider"
  | "detector"
  | "policy-rule"
  | "source-adapter"
  | "code-structure"
  | "semantic-edge"
  | "coding-agent"
  | "helper-model"
  | "evaluation";

export interface ProducerMetadata {
  readonly producerId: string;
  readonly kind: ProducerKind;
  readonly version: string;
  readonly digest: string;
}

export interface VersionedProducer {
  readonly metadata: ProducerMetadata;
}

export interface FeatureProvider<Input, Output> extends VersionedProducer {
  provide(input: Input): Result<Output>;
}

export interface DetectorResult<Finding> {
  readonly producer: ProducerMetadata;
  readonly findings: readonly Finding[];
  readonly warnings: readonly string[];
}

export interface Detector<Input, Finding> extends VersionedProducer {
  detect(input: Input): Result<DetectorResult<Finding>>;
}

export type ObligationStatus =
  | "satisfied"
  | "missing"
  | "ambiguous"
  | "contradicted"
  | "stale";

export interface EvidenceObligation {
  readonly obligationId: string;
  readonly kind: string;
  readonly description: string;
  readonly status: ObligationStatus;
  readonly evidenceIds: readonly string[];
  readonly reasons: readonly string[];
  readonly producer: ProducerMetadata;
}

export interface PolicyDecision<T> {
  readonly action: "accept" | "reject" | "preserve" | "gather";
  readonly priority: number;
  readonly value?: T;
  readonly reasons: readonly string[];
  readonly producer: ProducerMetadata;
}

export interface PolicyRule<Input, Output> extends VersionedProducer {
  decide(input: Input): Result<PolicyDecision<Output>>;
}

export interface SourceAdapter<Request, Snapshot> extends VersionedProducer {
  capture(request: Request): Promise<Result<Snapshot>>;
}

export interface CodeStructureProvider<Request, Unit>
  extends VersionedProducer {
  units(request: Request): Result<readonly Unit[]>;
}

export interface SemanticEdgeProvider<Request, Edge>
  extends VersionedProducer {
  edges(request: Request): Result<readonly Edge[]>;
}

export interface CodingAgentAdapter extends CodingAgentHandoffPort, VersionedProducer {}

export interface HelperModelAdapter<Request, Suggestion>
  extends VersionedProducer {
  suggest(request: Request): Promise<Result<readonly Suggestion[]>>;
}

export interface EvaluationAdapter<Case, ResultValue>
  extends VersionedProducer {
  run(testCase: Case): Promise<Result<ResultValue>>;
}

export interface ArtifactClassificationRequest {
  readonly artifact: ArtifactSnapshot;
}

export interface IntentClassificationRequest {
  readonly prompt: ArtifactSnapshot;
}

export interface OutcomeDetectionRequest {
  readonly artifact: ArtifactSnapshot;
}

export interface EvidenceDetectionRequest {
  readonly artifact: ArtifactSnapshot;
  readonly classification: ArtifactClassification;
  readonly outcome: RunOutcome;
}

export interface ReductionDetectionRequest {
  readonly artifact: ArtifactSnapshot;
  readonly classification: ArtifactClassification;
  readonly outcome: RunOutcome;
}

export interface ReductionPolicyRequest {
  readonly runId: string;
  readonly artifact: ArtifactSnapshot;
  readonly proposals: readonly TransformProposal[];
  readonly protectedRanges: readonly ProtectedRange[];
}

export interface BuiltinRuntime {
  readonly producers: readonly ProducerMetadata[];
  readonly registryDigest: string;
  classifyArtifact(artifact: ArtifactSnapshot): Result<ArtifactClassification>;
  classifyIntent(prompt: ArtifactSnapshot): Result<IntentClassification>;
  detectOutcome(artifact: ArtifactSnapshot): Result<RunOutcome>;
  detectEvidence(
    request: EvidenceDetectionRequest
  ): Result<DetectorResult<EvidenceSpan>>;
  segment(artifact: ArtifactSnapshot): Result<readonly Segment[]>;
  detectReductions(
    request: ReductionDetectionRequest
  ): Result<DetectorResult<TransformProposal>>;
  plan(
    request: ReductionPolicyRequest
  ): Result<PolicyDecision<readonly PlannedTransform[]>>;
}

