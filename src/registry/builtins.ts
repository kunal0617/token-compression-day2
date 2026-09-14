import {
  classifyArtifact,
  classifyIntent,
  determineOutcome
} from "../classify/classify.js";
import type {
  ArtifactClassificationRequest,
  BuiltinRuntime,
  Detector,
  EvidenceDetectionRequest,
  FeatureProvider,
  IntentClassificationRequest,
  OutcomeDetectionRequest,
  PolicyRule,
  ProducerKind,
  ProducerMetadata,
  ReductionDetectionRequest,
  ReductionPolicyRequest
} from "../contracts/providers.js";
import type {
  ArtifactClassification,
  ArtifactSnapshot,
  EvidenceSpan,
  IntentClassification,
  PlannedTransform,
  RunOutcome,
  Segment,
  TransformProposal
} from "../contracts/types.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import { success, type Result } from "../core/result.js";
import { extractEvidence } from "../evidence/extract.js";
import { planTransforms } from "../reduce/planner.js";
import { proposeTransforms } from "../reduce/propose.js";
import {
  exactSourceProvenanceProvider,
  localApprovedSourceAdapter
} from "../provenance/exact.js";
import {
  conservativeFailureFallbackDetector,
  nodeV8FailureDetector,
  typedFailureParsers,
  vitestJestFailureDetector
} from "../parsers/failures.js";
import {
  evidenceObligationEvaluator,
  gatherMoreEvidencePolicy
} from "../obligations/evaluate.js";
import {
  conservativeFileStructureProvider,
  treeSitterJsTsStructureProvider
} from "../source/tree-sitter.js";
import { typeScriptSemanticEdgeProvider } from "../source/typescript-semantic.js";
import { reviewSubjectProvider } from "../approval/review.js";
import { optionalCopilotSdkAdapter } from "../adapters/copilot-sdk.js";
import { deterministicModelFitAdviser } from "../model/advice.js";
import { isolatedGapSuggestionProducer } from "../helper/isolation.js";
import { segmentArtifact } from "../segment/segment.js";
import { VersionedRegistry } from "./registry.js";
import {
  compareProducerMetadata,
  producerSnapshotMatchesRegistry
} from "./registry.js";

function metadata(
  producerId: string,
  kind: ProducerKind,
  version: string,
  contract: unknown
): ProducerMetadata {
  return {
    producerId,
    kind,
    version,
    digest: canonicalJsonDigest({ producerId, kind, version, contract })
  };
}

class ArtifactClassifier
  implements
    FeatureProvider<ArtifactClassificationRequest, ArtifactClassification>
{
  readonly metadata = metadata(
    "builtin.artifact-classifier",
    "feature-provider",
    "2.0.0",
    ["prompt", "test", "compiler", "stack", "diff", "log", "source", "text"]
  );

  provide(
    request: ArtifactClassificationRequest
  ): Result<ArtifactClassification> {
    return success(classifyArtifact(request.artifact));
  }
}

class IntentClassifier
  implements FeatureProvider<IntentClassificationRequest, IntentClassification>
{
  readonly metadata = metadata(
    "builtin.intent-classifier",
    "feature-provider",
    "1.0.0",
    ["debug", "fix", "test", "build", "review", "explain", "general"]
  );

  provide(
    request: IntentClassificationRequest
  ): Result<IntentClassification> {
    return success(classifyIntent(request.prompt));
  }
}

class OutcomeDetector
  implements FeatureProvider<OutcomeDetectionRequest, RunOutcome>
{
  readonly metadata = metadata(
    "builtin.outcome-detector",
    "feature-provider",
    "2.0.0",
    ["structured-exit", "ci-conclusion", "parser-verdict", "summary"]
  );

  provide(request: OutcomeDetectionRequest): Result<RunOutcome> {
    return success(determineOutcome([request.artifact]));
  }
}

class EvidenceDetector
  implements Detector<EvidenceDetectionRequest, EvidenceSpan>
{
  readonly metadata = metadata(
    "builtin.evidence-detector",
    "detector",
    "2.0.0",
    ["occurrence-specific", "ci-envelope", "diagnostic-elevation"]
  );

  detect(
    request: EvidenceDetectionRequest
  ): Result<{
    producer: ProducerMetadata;
    findings: readonly EvidenceSpan[];
    warnings: readonly string[];
  }> {
    return success({
      producer: this.metadata,
      findings: Object.freeze(
        extractEvidence(
          request.artifact,
          request.classification,
          request.outcome
        )
      ),
      warnings: []
    });
  }
}

class SegmentProvider implements FeatureProvider<ArtifactSnapshot, readonly Segment[]> {
  readonly metadata = metadata(
    "builtin.segment-provider",
    "feature-provider",
    "1.0.0",
    ["raw-lines", "stateful-diff"]
  );

  provide(artifact: ArtifactSnapshot): Result<readonly Segment[]> {
    return success(Object.freeze(segmentArtifact(artifact)));
  }
}

class ReductionDetector
  implements Detector<ReductionDetectionRequest, TransformProposal>
{
  readonly metadata = metadata(
    "builtin.reduction-detector",
    "detector",
    "2.0.0",
    ["exact", "success", "boilerplate", "volatile", "ci-wrapper"]
  );

  detect(
    request: ReductionDetectionRequest
  ): Result<{
    producer: ProducerMetadata;
    findings: readonly TransformProposal[];
    warnings: readonly string[];
  }> {
    return success({
      producer: this.metadata,
      findings: Object.freeze(
        proposeTransforms(
          request.artifact,
          request.classification,
          request.outcome
        )
      ),
      warnings: []
    });
  }
}

class ReductionPolicy
  implements PolicyRule<ReductionPolicyRequest, readonly PlannedTransform[]>
{
  readonly metadata = metadata(
    "builtin.reduction-policy",
    "policy-rule",
    "2.0.0",
    ["protected-first", "priority", "benefit", "non-overlap", "source-order"]
  );

  decide(
    request: ReductionPolicyRequest
  ): Result<{
    action: "accept";
    priority: number;
    value: readonly PlannedTransform[];
    reasons: readonly string[];
    producer: ProducerMetadata;
  }> {
    const plan = planTransforms(
      request.runId,
      request.artifact,
      request.proposals,
      request.protectedRanges
    );
    return success({
      action: "accept",
      priority: 100,
      value: plan.selected,
      reasons: [
        `${plan.rejectedProtected.length} protected proposals rejected`,
        `${plan.rejectedOverlap.length} overlapping proposals rejected`,
        `${plan.rejectedNonBeneficial.length} non-beneficial proposals rejected`
      ],
      producer: this.metadata
    });
  }
}

export function createBuiltinRuntime(): BuiltinRuntime {
  const artifactClassifier = new ArtifactClassifier();
  const intentClassifier = new IntentClassifier();
  const outcomeDetector = new OutcomeDetector();
  const evidenceDetector = new EvidenceDetector();
  const segmentProvider = new SegmentProvider();
  const reductionDetector = new ReductionDetector();
  const reductionPolicy = new ReductionPolicy();
  const registry = new VersionedRegistry<
    | ArtifactClassifier
    | IntentClassifier
    | OutcomeDetector
    | EvidenceDetector
    | SegmentProvider
    | ReductionDetector
    | ReductionPolicy
    | typeof exactSourceProvenanceProvider
    | typeof localApprovedSourceAdapter
    | typeof vitestJestFailureDetector
    | typeof nodeV8FailureDetector
    | typeof conservativeFailureFallbackDetector
    | typeof evidenceObligationEvaluator
    | typeof gatherMoreEvidencePolicy
    | typeof treeSitterJsTsStructureProvider
    | typeof conservativeFileStructureProvider
    | typeof typeScriptSemanticEdgeProvider
    | typeof reviewSubjectProvider
    | typeof optionalCopilotSdkAdapter
    | typeof deterministicModelFitAdviser
    | typeof isolatedGapSuggestionProducer
  >();
  const preparation = [
    artifactClassifier,
    intentClassifier,
    outcomeDetector,
    evidenceDetector,
    segmentProvider,
    reductionDetector,
    reductionPolicy
  ] as const;
  for (const producer of [
    artifactClassifier,
    intentClassifier,
    outcomeDetector,
    evidenceDetector,
    segmentProvider,
    reductionDetector,
    reductionPolicy,
    exactSourceProvenanceProvider,
    localApprovedSourceAdapter
    ,
    vitestJestFailureDetector,
    nodeV8FailureDetector,
    conservativeFailureFallbackDetector
    ,
    evidenceObligationEvaluator,
    gatherMoreEvidencePolicy
    ,
    treeSitterJsTsStructureProvider,
    conservativeFileStructureProvider,
    typeScriptSemanticEdgeProvider
    ,
    reviewSubjectProvider
    ,
    optionalCopilotSdkAdapter
    ,
    deterministicModelFitAdviser
    ,
    isolatedGapSuggestionProducer
  ]) {
    const registered = registry.register(producer);
    if (!registered.ok) throw new Error(registered.error.message);
  }
  return {
    producers: registry.metadata(),
    registryDigest: registry.digest(),
    preparationProducers: Object.freeze(
      preparation
        .map((producer) => producer.metadata)
        .sort(compareProducerMetadata)
    ),
    preparationRegistryDigest: canonicalJsonDigest(
      preparation
        .map((producer) => producer.metadata)
        .sort(compareProducerMetadata)
    ),
    resolveProducer: (producerMetadata) =>
      producerSnapshotMatchesRegistry([producerMetadata], registry),
    classifyArtifact: (artifact) =>
      artifactClassifier.provide({ artifact }),
    classifyIntent: (prompt) => intentClassifier.provide({ prompt }),
    detectOutcome: (artifact) => outcomeDetector.provide({ artifact }),
    detectEvidence: (request) => evidenceDetector.detect(request),
    parseFailures: (artifact) => typedFailureParsers.parse(artifact),
    segment: (artifact) => segmentProvider.provide(artifact),
    detectReductions: (request) => reductionDetector.detect(request),
    plan: (request) => reductionPolicy.decide(request)
  };
}

export const builtinRuntime = createBuiltinRuntime();
