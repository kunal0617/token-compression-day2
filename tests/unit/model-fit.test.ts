import { describe, expect, it } from "vitest";

import type { ModelCatalogEntry } from "../../src/contracts/agent.js";
import {
  createCuratedModelPolicy,
  deterministicModelFitAdviser
} from "../../src/model/advice.js";

const catalog: ModelCatalogEntry[] = [
  {
    id: "exact-fast",
    name: "Exact Fast",
    capabilities: {
      maxInputTokens: 32_000,
      supportsTools: true,
      supportsReasoning: false,
      latencyTier: 1,
      costTier: 1,
      reasoningTier: 1
    }
  },
  {
    id: "routine-cheap",
    name: "Routine Cheap",
    capabilities: {
      maxInputTokens: 64_000,
      supportsTools: true,
      supportsReasoning: false,
      latencyTier: 2,
      costTier: 1,
      reasoningTier: 1
    }
  },
  {
    id: "reasoning-strong",
    name: "Reasoning Strong",
    capabilities: {
      maxInputTokens: 128_000,
      supportsTools: true,
      supportsReasoning: true,
      latencyTier: 4,
      costTier: 4,
      reasoningTier: 10
    }
  }
];

const policy = createCuratedModelPolicy({
  version: "test-1",
  entries: [
    {
      modelId: "exact-fast",
      allowedOperations: ["MF-01-exact-operation"],
      enabled: true
    },
    {
      modelId: "routine-cheap",
      allowedOperations: ["MF-02-bounded-routine"],
      enabled: true
    },
    {
      modelId: "reasoning-strong",
      allowedOperations: ["MF-03-reasoning-intensive"],
      enabled: true
    }
  ]
});

describe("MF-01/MF-02/MF-03 deterministic model fit", () => {
  it("keeps a capable current model for exact operations", () => {
    const advice = deterministicModelFitAdviser.provide({
      operation: "MF-01-exact-operation",
      currentModelId: "exact-fast",
      requiredInputTokens: 1_000,
      requiresTools: false,
      requiresVision: false,
      evidenceDecision: "ready",
      catalog,
      policy
    });
    expect(advice.ok).toBe(true);
    if (!advice.ok) return;
    expect(advice.value.decision).toBe("keep-current");
    expect(advice.value.requiresNewSession).toBe(false);
  });

  it("recommends a new session for the best bounded-routine model", () => {
    const advice = deterministicModelFitAdviser.provide({
      operation: "MF-02-bounded-routine",
      currentModelId: "exact-fast",
      requiredInputTokens: 10_000,
      requiresTools: true,
      requiresVision: false,
      evidenceDecision: "ready",
      catalog,
      policy
    });
    expect(advice.ok).toBe(true);
    if (!advice.ok) return;
    expect(advice.value).toMatchObject({
      decision: "recommend-new-session",
      recommendedModelId: "routine-cheap",
      requiresNewSession: true
    });
  });

  it("hard-filters reasoning-intensive work to advertised reasoning models", () => {
    const advice = deterministicModelFitAdviser.provide({
      operation: "MF-03-reasoning-intensive",
      currentModelId: "routine-cheap",
      requiredInputTokens: 50_000,
      requiresTools: true,
      requiresVision: false,
      evidenceDecision: "ready",
      catalog,
      policy
    });
    expect(advice.ok).toBe(true);
    if (!advice.ok) return;
    expect(advice.value.recommendedModelId).toBe("reasoning-strong");
    expect(
      advice.value.scores.find((score) => score.modelId === "routine-cheap")
        ?.eligible
    ).toBe(false);
  });

  it("never lets model advice override missing evidence", () => {
    const advice = deterministicModelFitAdviser.provide({
      operation: "MF-03-reasoning-intensive",
      currentModelId: "exact-fast",
      requiredInputTokens: 1_000,
      requiresTools: false,
      requiresVision: false,
      evidenceDecision: "gather-more-evidence",
      catalog,
      policy
    });
    expect(advice.ok).toBe(true);
    if (!advice.ok) return;
    expect(advice.value.decision).toBe("keep-current");
    expect(advice.value.recommendedModelId).toBeUndefined();
    expect(advice.value.reasons[0]).toContain("Missing evidence");
  });

  it("keeps current when catalog and policy are unknown or conflicting", () => {
    const advice = deterministicModelFitAdviser.provide({
      operation: "MF-02-bounded-routine",
      currentModelId: "current",
      requiredInputTokens: 1_000,
      requiresTools: false,
      requiresVision: true,
      evidenceDecision: "ready",
      catalog: [
        {
          id: "unknown",
          name: "Unknown",
          capabilities: {}
        }
      ],
      policy,
    });
    expect(advice.ok).toBe(true);
    if (!advice.ok) return;
    expect(advice.value.decision).toBe("keep-current");
    expect(advice.value.reasons[0]).toContain("No catalog model");
  });

  it("canonicalizes curated policy order and digest", () => {
    const reversed = createCuratedModelPolicy({
      version: "test-1",
      entries: [...policy.entries].reverse()
    });
    expect(reversed.digest).toBe(policy.digest);
    expect(reversed.entries).toEqual(policy.entries);
  });
});

