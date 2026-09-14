import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  EvaluationCase,
  EvaluationObservation,
  EvaluationTrialPlan
} from "../../src/contracts/evaluation.js";
import { canonicalJsonDigest } from "../../src/core/canonical.js";
import {
  createReplayManifest,
  evaluationCsv,
  evaluationJson,
  evaluationMarkdown,
  runPairedEvaluation
} from "../../src/evaluation/harness.js";
import { parseEvaluationObservation } from "../../src/evaluation/harness.js";
import {
  createLunaAdapter,
  createRohitCqAdapter,
  createRohitMfAdapter,
  ExternalLocalFixtureAdapter
} from "../../src/evaluation/external.js";
import { success } from "../../src/core/result.js";

const cases: EvaluationCase[] = Array.from({ length: 3 }, (_, index) => ({
  caseId: `case-${index + 1}`,
  title: `Case ${index + 1}`,
  prompt: "Diagnose",
  artifactPaths: [],
  expectedEvidenceIds: ["evidence"],
  expectedFailureIds: ["failure"],
  expectedCitations: ["src/a.ts:1"],
  allowAbstention: false,
  source: index === 2 ? "held-out" : "neutral"
}));

function observation(
  plan: EvaluationTrialPlan,
  preparedWins = true
): EvaluationObservation {
  const prepared = plan.arm === "prepared";
  const successful = prepared ? preparedWins : false;
  return {
    trialId: plan.trialId,
    caseId: plan.caseId,
    arm: plan.arm,
    modelId: plan.settings.modelId,
    settingsDigest: canonicalJsonDigest(plan.settings),
    sessionConstraintDigest: plan.sessionConstraintDigest,
    taskSuccess: successful,
    visibleEvidenceIds: successful ? ["evidence"] : [],
    recoverableEvidenceIds: ["evidence"],
    distinctFailureIds: successful ? ["failure"] : [],
    citations: successful ? ["src/a.ts:1"] : [],
    unsupportedClaims: 0,
    contradictions: 0,
    abstained: false,
    retrievalTokens: prepared ? 20 : 0,
    retrievalCalls: prepared ? 1 : 0,
    retrievalLatencyMs: prepared ? 5 : 0,
    preparationLatencyMs: prepared ? 10 : 0,
    reviewLatencyMs: 2,
    handoffLatencyMs: 3,
    modelLatencyMs: 50,
    decisions: 1,
    tools: prepared ? 1 : 0,
    permissions: 0,
    execution: {
      adapterProducerId: plan.settings.adapterId,
      executableDigest: canonicalJsonDigest("executable"),
      protocolDigest: canonicalJsonDigest("protocol"),
      actualModelId: plan.settings.modelId,
      actualSettingsDigest: canonicalJsonDigest(plan.settings),
      sessionId: `session-${plan.trialId}`,
      newSession: true
    }
  };
}

describe("paired evaluation harness", () => {
  it("creates three matched original/prepared trials and requires live opt-in", async () => {
    const manifest = createReplayManifest({
      suiteId: "suite",
      cases,
      settings: {
        modelId: "model",
        permissionDigest: canonicalJsonDigest("permissions"),
        adapterId: "adapter"
      },
      seed: 42,
      liveOptIn: false
    });
    expect(manifest.plans).toHaveLength(18);
    for (const testCase of cases) {
      for (let trial = 1; trial <= 3; trial += 1) {
        const pair = manifest.plans.filter(
          (plan) =>
            plan.caseId === testCase.caseId &&
            plan.trialNumber === trial
        );
        expect(new Set(pair.map((plan) => plan.sessionConstraintDigest)).size).toBe(
          1
        );
      }
    }
    const blocked = await runPairedEvaluation({
      manifest,
      runner: { run: async () => success(observation(manifest.plans[0] as EvaluationTrialPlan)) }
    });
    expect(blocked.ok).toBe(false);
    const stale = await runPairedEvaluation({
      manifest: { ...manifest, liveOptIn: true },
      runner: {
        run: async (plan) => success(observation(plan))
      }
    });
    expect(stale.ok).toBe(false);
  });

  it("replays deterministic counterbalanced order from the seed", () => {
    const input = {
      suiteId: "counterbalanced",
      cases,
      settings: {
        modelId: "model",
        permissionDigest: canonicalJsonDigest("permissions"),
        adapterId: "adapter"
      },
      liveOptIn: false,
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    const first = createReplayManifest({ ...input, seed: 42 });
    const repeated = createReplayManifest({ ...input, seed: 42 });
    const changed = createReplayManifest({ ...input, seed: 43 });
    expect(first.digest).toBe(repeated.digest);
    expect(first.plans).toEqual(repeated.plans);
    expect(changed.plans).not.toEqual(first.plans);
  });

  it("reports paired discordance, bootstrap, effect size, and all formats", async () => {
    const manifest = createReplayManifest({
      suiteId: "suite",
      cases,
      settings: {
        modelId: "model",
        reasoningEffort: "medium",
        permissionDigest: canonicalJsonDigest("permissions"),
        adapterId: "adapter"
      },
      seed: 123,
      liveOptIn: true,
      trialsPerArm: 3
    });
    const result = await runPairedEvaluation({
      manifest,
      runner: {
        run: async (plan) => success(observation(plan))
      },
      aaObservations: manifest.plans
        .filter((plan) => plan.arm === "original")
        .slice(0, 3)
        .flatMap((plan, index) => [
          {
            ...observation(plan, false),
            execution: {
              ...observation(plan, false).execution,
              sessionId: `aa-${index}-1`
            },
            aaPairId: `aa-${index}`,
            aaVariant: "A1" as const
          },
          {
            ...observation(plan, false),
            execution: {
              ...observation(plan, false).execution,
              sessionId: `aa-${index}-2`
            },
            aaPairId: `aa-${index}`,
            aaVariant: "A2" as const
          }
        ])
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.preparedMean).toBeGreaterThan(
      result.value.originalMean
    );
    expect(result.value.discordance.preparedWins).toBe(9);
    expect(result.value.reportingFloorMet).toBe(true);
    expect(result.value.bootstrap95[0]).toBeGreaterThan(0);
    expect(result.value.effectSizeDz).toBeNull();
    expect(
      result.value.warnings.some((warning) =>
        warning.includes("variance is zero")
      )
    ).toBe(true);
    expect(result.value.aaNoise).toBeCloseTo(0, 12);
    expect(evaluationJson(result.value)).toContain(manifest.digest);
    expect(evaluationMarkdown(result.value)).toContain("# Paired evaluation");
    expect(evaluationCsv(result.value).split("\n")).toHaveLength(
      result.value.scores.length + 1
    );
  });

  it("reports systematic A/A paired differences as noise", async () => {
    const manifest = createReplayManifest({
      suiteId: "aa-noise",
      cases: [cases[0] as EvaluationCase],
      settings: {
        modelId: "model",
        permissionDigest: canonicalJsonDigest("permissions"),
        adapterId: "adapter"
      },
      seed: 7,
      liveOptIn: true,
      trialsPerArm: 1
    });
    const plan = manifest.plans.find(
      (candidate) => candidate.arm === "original"
    ) as EvaluationTrialPlan;
    const base = observation(plan, false);
    const result = await runPairedEvaluation({
      manifest,
      runner: { run: async (trial) => success(observation(trial)) },
      aaObservations: [
        {
          ...base,
          aaPairId: "aa-systematic",
          aaVariant: "A1",
          execution: { ...base.execution, sessionId: "aa-systematic-1" }
        },
        {
          ...base,
          taskSuccess: true,
          visibleEvidenceIds: ["evidence"],
          distinctFailureIds: ["failure"],
          citations: ["src/a.ts:1"],
          aaPairId: "aa-systematic",
          aaVariant: "A2",
          execution: { ...base.execution, sessionId: "aa-systematic-2" }
        }
      ]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.aaNoise).toBeGreaterThan(0);
  });

  it("fails mismatched model/settings/session observations", async () => {
    const manifest = createReplayManifest({
      suiteId: "mismatch",
      cases: [cases[0] as EvaluationCase],
      settings: {
        modelId: "model",
        permissionDigest: canonicalJsonDigest("permissions"),
        adapterId: "adapter"
      },
      seed: 1,
      liveOptIn: true
    });

    const result = await runPairedEvaluation({
      manifest,
      runner: {
        run: async (plan) =>
          success({ ...observation(plan), modelId: "different" })
      }
    });
    expect(result.ok).toBe(false);
  });

  it("reports when case/trial floors are not met", async () => {
    const manifest = createReplayManifest({
      suiteId: "floor",
      cases: [cases[0] as EvaluationCase],
      settings: {
        modelId: "model",
        permissionDigest: canonicalJsonDigest("permissions"),
        adapterId: "adapter"
      },
      seed: 8,
      liveOptIn: true,
      trialsPerArm: 1
    });

    const result = await runPairedEvaluation({
      manifest,
      runner: { run: async (plan) => success(observation(plan)) }
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reportingFloorMet).toBe(false);
    expect(result.value.warnings.length).toBeGreaterThan(0);
  });

  it("rejects incomplete plans and invalid observation numbers", async () => {
    const manifest = createReplayManifest({
      suiteId: "invalid",
      cases: [cases[0] as EvaluationCase],
      settings: {
        modelId: "model",
        permissionDigest: canonicalJsonDigest("permissions"),
        adapterId: "adapter"
      },
      seed: 10,
      liveOptIn: true
    });
    const { digest: _digest, ...unsigned } = manifest;
    const incompleteUnsigned = {
      ...unsigned,
      plans: unsigned.plans.slice(1)
    };
    const incomplete = {
      ...incompleteUnsigned,
      digest: canonicalJsonDigest(incompleteUnsigned)
    };
    expect(
      (
        await runPairedEvaluation({
          manifest: incomplete,
          runner: { run: async (plan) => success(observation(plan)) }
        })
      ).ok
    ).toBe(false);
    expect(
      parseEvaluationObservation({
        ...observation(manifest.plans[0] as EvaluationTrialPlan),
        modelLatencyMs: Number.NaN
      }).ok
    ).toBe(false);
  });

  it("loads neutral fixtures and keeps Rohit/Luna adapters external-root only", async () => {
    const fixtures = new ExternalLocalFixtureAdapter(resolve("fixtures"));
    const loaded = fixtures.loadCases("evaluation/neutral-cases.json");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value).toHaveLength(3);

    const directory = mkdtempSync(join(tmpdir(), "ctxo-external-eval-"));
    const outside = `${directory}-outside`;
    try {
      mkdirSync(outside);
      writeFileSync(join(outside, "artifact.log"), "outside", "utf8");
      writeFileSync(
        join(directory, "manifest.json"),
        JSON.stringify({
          cases: [
            {
              ...cases[0],
              artifactPaths: ["../ctxo-external-eval-outside/artifact.log"]
            }
          ]
        }),
        "utf8"
      );
      const external = new ExternalLocalFixtureAdapter(directory);
      expect(external.loadCases("manifest.json").ok).toBe(false);

      const input = {
        externalRoot: directory,
        command: process.execPath,
        args: ["--version"]
      };
      const cqAdapter = createRohitCqAdapter(input);
      expect(cqAdapter.metadata.producerId).toContain(
        "rohit.cq"
      );
      expect(createRohitMfAdapter(input).metadata.producerId).toContain(
        "rohit.mf"
      );
      expect(createLunaAdapter(input).metadata.producerId).toContain("luna");
      expect(
        (
          await cqAdapter.run({
            plan: createReplayManifest({
              suiteId: "disabled-external",
              cases: [cases[0] as EvaluationCase],
              settings: {
                modelId: "model",
                permissionDigest: canonicalJsonDigest("permissions"),
                adapterId: cqAdapter.metadata.producerId
              },
              seed: 1,
              liveOptIn: true,
              trialsPerArm: 1
            }).plans[0] as EvaluationTrialPlan,
            testCase: cases[0] as EvaluationCase
          })
        ).ok
      ).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
