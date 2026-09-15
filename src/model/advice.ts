import type { ModelCatalogEntry } from "../contracts/agent.js";
import type {
  CuratedModelPolicy,
  CuratedModelPolicyEntry,
  ModelFitAdvice,
  ModelFitRequest,
  ModelScore,
  OperationClass
} from "../contracts/model-fit.js";
import type {
  FeatureProvider,
  ProducerMetadata
} from "../contracts/providers.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import { failure, success, type Result } from "../core/result.js";

function producer(): ProducerMetadata {
  const producerId = "builtin.mf.model-fit-adviser";
  const version = "1.0.0";
  return {
    producerId,
    kind: "feature-provider",
    version,
    digest: canonicalJsonDigest({
      producerId,
      version,
      contract: [
        "MF-01",
        "MF-02",
        "MF-03",
        "hard-filters",
        "evidence-veto",
        "new-session-only"
      ]
    })
  };
}

function capabilityBoolean(
  model: ModelCatalogEntry,
  keys: readonly string[]
): boolean | undefined {
  for (const key of keys) {
    const value = model.capabilities[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function capabilityNumber(
  model: ModelCatalogEntry,
  keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = model.capabilities[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function entryFor(
  policy: CuratedModelPolicy,
  modelId: string
): CuratedModelPolicyEntry | undefined {
  return policy.entries.find((entry) => entry.modelId === modelId);
}

export function createCuratedModelPolicy(input: {
  readonly version: string;
  readonly entries: readonly (Omit<CuratedModelPolicyEntry, "notes"> & {
    readonly notes?: readonly string[];
  })[];
}): CuratedModelPolicy {
  const entries = input.entries
    .map((entry) => ({
      modelId: entry.modelId,
      allowedOperations: [...entry.allowedOperations].sort(),
      enabled: entry.enabled,
      notes: [...(entry.notes ?? [])]
    }))
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.modelId, "utf8"),
        Buffer.from(right.modelId, "utf8")
      )
    );
  return {
    version: input.version,
    entries,
    digest: canonicalJsonDigest({ version: input.version, entries })
  };
}

function scoreModel(
  model: ModelCatalogEntry,
  request: ModelFitRequest
): ModelScore {
  const policy = entryFor(request.policy, model.id);
  const reasons: string[] = [];
  let eligible = true;
  if (
    policy === undefined ||
    !policy.enabled ||
    !policy.allowedOperations.includes(request.operation)
  ) {
    eligible = false;
    reasons.push("Model is not enabled for this operation by curated policy");
  }
  const context = capabilityNumber(model, [
    "maxInputTokens",
    "contextWindow",
    "maxPromptTokens"
  ]);
  if (context === undefined) {
    eligible = false;
    reasons.push("Model does not advertise a context limit");
  } else if (context < request.requiredInputTokens) {
    eligible = false;
    reasons.push("Model context limit is below required input tokens");
  }
  if (
    request.requiresTools &&
    capabilityBoolean(model, ["supportsTools", "tools"]) !== true
  ) {
    eligible = false;
    reasons.push("Model does not positively advertise required tools");
  }
  if (
    request.requiresVision &&
    capabilityBoolean(model, ["supportsVision", "vision"]) !== true
  ) {
    eligible = false;
    reasons.push("Model does not advertise required vision capability");
  }
  if (
    request.operation === "MF-03-reasoning-intensive" &&
    capabilityBoolean(model, [
      "supportsReasoning",
      "reasoning",
      "supports.reasoning"
    ]) !== true
  ) {
    eligible = false;
    reasons.push("Reasoning-intensive operation requires advertised reasoning");
  }
  const latency = capabilityNumber(model, ["latencyTier", "relativeLatency"]) ?? 5;
  const cost = capabilityNumber(model, ["costTier", "relativeCost"]) ?? 5;
  const reasoning =
    capabilityNumber(model, ["reasoningTier", "reasoningStrength"]) ?? 0;
  const score =
    request.operation === "MF-01-exact-operation"
      ? 100 - latency * 5 - cost * 3
      : request.operation === "MF-02-bounded-routine"
        ? 100 - latency * 4 - cost * 5
        : 100 + reasoning * 10 - latency * 2 - cost * 2;
  if (eligible) reasons.push(`Deterministic score ${score}`);
  return { modelId: model.id, eligible, score, reasons };
}

export class DeterministicModelFitAdviser
  implements FeatureProvider<ModelFitRequest, ModelFitAdvice>
{
  readonly metadata = producer();

  provide(request: ModelFitRequest): Result<ModelFitAdvice> {
    if (
      request.policy.digest !==
        canonicalJsonDigest({
          version: request.policy.version,
          entries: request.policy.entries
        }) ||
      new Set(request.policy.entries.map((entry) => entry.modelId)).size !==
        request.policy.entries.length ||
      new Set(request.catalog.map((model) => model.id)).size !==
        request.catalog.length ||
      !Number.isSafeInteger(request.requiredInputTokens) ||
      request.requiredInputTokens < 0
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Model catalog, policy, or token requirement is invalid"
      );
    }
    const scores = request.catalog
      .map((model) => scoreModel(model, request))
      .sort(
        (left, right) =>
          Number(right.eligible) - Number(left.eligible) ||
          right.score - left.score ||
          Buffer.compare(
            Buffer.from(left.modelId, "utf8"),
            Buffer.from(right.modelId, "utf8")
          )
      );
    if (request.evidenceDecision !== "ready") {
      return success({
        operation: request.operation,
        decision: "keep-current",
        ...(request.currentModelId === undefined
          ? {}
          : { currentModelId: request.currentModelId }),
        requiresNewSession: false,
        scores,
        reasons: [
          "Missing evidence takes precedence over model selection"
        ],
        policyVersion: request.policy.version,
        policyDigest: request.policy.digest,
        producer: this.metadata
      });
    }
    const best = scores.find((score) => score.eligible);
    const current =
      request.currentModelId === undefined
        ? undefined
        : scores.find((score) => score.modelId === request.currentModelId);
    const tiedBest =
      best === undefined
        ? []
        : scores.filter(
            (score) => score.eligible && score.score === best.score
          );
    if (
      request.currentModelId !== undefined &&
      best !== undefined &&
      (current === undefined ||
        (tiedBest.length > 1 &&
          !tiedBest.some(
            (score) => score.modelId === request.currentModelId
          )))
    ) {
      return success({
        operation: request.operation,
        decision: "keep-current",
        currentModelId: request.currentModelId,
        requiresNewSession: false,
        scores,
        reasons: [
          current === undefined
            ? "Current model is absent from the catalog; keep current under uncertainty"
            : "Top model scores conflict; keep current"
        ],
        policyVersion: request.policy.version,
        policyDigest: request.policy.digest,
        producer: this.metadata
      });
    }
    if (
      best === undefined ||
      (current?.eligible === true && current.score >= best.score)
    ) {
      return success({
        operation: request.operation,
        decision: "keep-current",
        ...(request.currentModelId === undefined
          ? {}
          : { currentModelId: request.currentModelId }),
        requiresNewSession: false,
        scores,
        reasons: [
          best === undefined
            ? "No catalog model passed hard filters; keep current"
            : "Current model satisfies policy and is not outscored"
        ],
        policyVersion: request.policy.version,
        policyDigest: request.policy.digest,
        producer: this.metadata
      });
    }
    if (request.currentModelId === undefined || best.modelId === request.currentModelId) {
      return success({
        operation: request.operation,
        decision: "keep-current",
        ...(request.currentModelId === undefined
          ? {}
          : { currentModelId: request.currentModelId }),
        ...(request.currentModelId === undefined
          ? { recommendedModelId: best.modelId }
          : {}),
        requiresNewSession: false,
        scores,
        reasons: [
          request.currentModelId === undefined
            ? "No current model was supplied; advice is informational"
            : "Best eligible model is already selected"
        ],
        policyVersion: request.policy.version,
        policyDigest: request.policy.digest,
        producer: this.metadata
      });
    }
    return success({
      operation: request.operation,
      decision: "recommend-new-session",
      currentModelId: request.currentModelId,
      recommendedModelId: best.modelId,
      requiresNewSession: true,
      scores,
      reasons: [
        `${best.modelId} is the highest deterministic eligible score`,
        "Model changes require an explicitly approved new session"
      ],
      policyVersion: request.policy.version,
      policyDigest: request.policy.digest,
      producer: this.metadata
    });
  }
}

export const deterministicModelFitAdviser =
  new DeterministicModelFitAdviser();

export const defaultCuratedModelPolicy = createCuratedModelPolicy({
  version: "1.0.0",
  entries: [
    {
      modelId: "auto",
      allowedOperations: [
        "MF-01-exact-operation",
        "MF-02-bounded-routine",
        "MF-03-reasoning-intensive"
      ],
      enabled: true,
      notes: ["Dynamic routing remains advisory"]
    }
  ]
});
