import type {
  EvaluationCase,
  EvaluationObservation,
  EvaluationReplayManifest,
  EvaluationRunSettings,
  EvaluationScore,
  EvaluationTrialPlan,
  PairedEvaluationReport
} from "../contracts/evaluation.js";
import type { ProducerMetadata } from "../contracts/providers.js";
import { canonicalJson, canonicalJsonDigest } from "../core/canonical.js";
import { deterministicUuid } from "../core/hash.js";
import { failure, success, type Result } from "../core/result.js";

export interface EvaluationArmRunner {
  run(
    plan: EvaluationTrialPlan,
    testCase: EvaluationCase
  ): Promise<Result<EvaluationObservation>>;
}

function producer(): ProducerMetadata {
  const producerId = "builtin.evaluation.paired-harness";
  const version = "1.0.0";
  return {
    producerId,
    kind: "evaluation",
    version,
    digest: canonicalJsonDigest({
      producerId,
      version,
      contract: [
        "A1-A3",
        "B1-B3",
        "optional-truncation",
        "matched-settings",
        "bootstrap",
        "effect-size",
        "discordance",
        "replay"
      ]
    })
  };
}

export function validateEvaluationCases(
  value: unknown
): Result<readonly EvaluationCase[]> {
  if (!Array.isArray(value)) {
    return failure("INTEGRITY_ERROR", "Evaluation cases are not an array");
  }
  const cases = value as Partial<EvaluationCase>[];
  const stringArrays = [
    "artifactPaths",
    "expectedEvidenceIds",
    "expectedFailureIds",
    "expectedCitations"
  ] as const;
  if (
    cases.some(
      (testCase) =>
        testCase === null ||
        typeof testCase !== "object" ||
        typeof testCase.caseId !== "string" ||
        testCase.caseId.length === 0 ||
        typeof testCase.title !== "string" ||
        testCase.title.length === 0 ||
        typeof testCase.prompt !== "string" ||
        typeof testCase.allowAbstention !== "boolean" ||
        !["neutral", "held-out", "external"].includes(
          testCase.source ?? ""
        ) ||
        stringArrays.some((field) => {
          const items = testCase[field];
          return (
            !Array.isArray(items) ||
            items.some((item) => typeof item !== "string") ||
            new Set(items).size !== items.length
          );
        })
    )
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Evaluation case contract is invalid"
    );
  }
  return success(cases as EvaluationCase[]);
}

export function validateReplayManifest(
  manifest: EvaluationReplayManifest
): Result<void> {
  const { digest, ...unsigned } = manifest;
  const cases = validateEvaluationCases(manifest.cases);
  if (
    !cases.ok ||
    digest !== canonicalJsonDigest(unsigned) ||
    manifest.formatVersion !== 1 ||
    typeof manifest.suiteId !== "string" ||
    manifest.suiteId.length === 0 ||
    !Number.isSafeInteger(manifest.seed) ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !Number.isInteger(manifest.trialsPerArm) ||
    manifest.trialsPerArm <= 0 ||
    canonicalJsonDigest(manifest.producer) !==
      canonicalJsonDigest(producer())
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Replay manifest digest or header is invalid"
    );
  }
  const caseIds = new Set(manifest.cases.map((item) => item.caseId));
  const trialIds = new Set(manifest.plans.map((item) => item.trialId));
  if (
    caseIds.size !== manifest.cases.length ||
    trialIds.size !== manifest.plans.length
  ) {
    return failure("INTEGRITY_ERROR", "Replay case or trial IDs are not unique");
  }
  const hasTruncation = manifest.plans.some(
    (plan) => plan.arm === "truncation"
  );
  const expectedArms = hasTruncation
    ? ["original", "prepared", "truncation"]
    : ["original", "prepared"];
  for (const testCase of manifest.cases) {
    for (let trial = 1; trial <= manifest.trialsPerArm; trial += 1) {
      const plans = manifest.plans.filter(
        (plan) =>
          plan.caseId === testCase.caseId &&
          plan.trialNumber === trial
      );
      if (
        plans.length !== expectedArms.length ||
        expectedArms.some(
          (arm) => plans.filter((plan) => plan.arm === arm).length !== 1
        ) ||
        new Set(
          plans.map((plan) => canonicalJsonDigest(plan.settings))
        ).size !== 1 ||
        new Set(plans.map((plan) => plan.sessionConstraintDigest)).size !== 1
      ) {
        return failure(
          "INTEGRITY_ERROR",
          "Replay manifest has incomplete or unmatched trial pairs",
          { caseId: testCase.caseId, trial }
        );
      }
    }
  }
  if (
    manifest.plans.some(
      (plan) =>
        plan.settings === undefined ||
        typeof plan.settings !== "object" ||
        typeof plan.trialId !== "string" ||
        plan.trialId.length === 0 ||
        typeof plan.caseId !== "string" ||
        !Number.isSafeInteger(plan.trialNumber) ||
        !["original", "prepared", "truncation"].includes(plan.arm) ||
        typeof plan.settings.modelId !== "string" ||
        plan.settings.modelId.length === 0 ||
        typeof plan.settings.permissionDigest !== "string" ||
        plan.settings.permissionDigest.length === 0 ||
        typeof plan.settings.adapterId !== "string" ||
        plan.settings.adapterId.length === 0 ||
        !/^[A-Za-z0-9_-]{43}$/.test(plan.sessionConstraintDigest) ||
        !caseIds.has(plan.caseId) ||
        plan.trialNumber < 1 ||
        plan.trialNumber > manifest.trialsPerArm
    )
  ) {
    return failure("INTEGRITY_ERROR", "Replay plan references invalid case or trial");
  }
  return success(undefined);
}

export function parseEvaluationObservation(
  value: unknown
): Result<EvaluationObservation> {
  if (value === null || typeof value !== "object") {
    return failure("INTEGRITY_ERROR", "Evaluation observation is not an object");
  }
  const observation = value as Partial<EvaluationObservation>;
  const stringFields = [
    "trialId",
    "caseId",
    "arm",
    "modelId",
    "settingsDigest",
    "sessionConstraintDigest"
  ] as const;
  const numberFields = [
    "unsupportedClaims",
    "contradictions",
    "retrievalTokens",
    "retrievalCalls",
    "retrievalLatencyMs",
    "preparationLatencyMs",
    "reviewLatencyMs",
    "handoffLatencyMs",
    "modelLatencyMs",
    "decisions",
    "tools",
    "permissions"
  ] as const;
  if (
    stringFields.some((field) => typeof observation[field] !== "string") ||
    !["original", "prepared", "truncation"].includes(
      observation.arm ?? ""
    ) ||
    typeof observation.taskSuccess !== "boolean" ||
    typeof observation.abstained !== "boolean" ||
    numberFields.some((field) => {
      const number = observation[field];
      return (
        typeof number !== "number" ||
        !Number.isFinite(number) ||
        number < 0
      );
    }) ||
    ![
      observation.visibleEvidenceIds,
      observation.recoverableEvidenceIds,
      observation.distinctFailureIds,
      observation.citations
    ].every(
      (items) =>
        Array.isArray(items) &&
        items.every((item) => typeof item === "string")
    ) ||
    observation.execution === undefined ||
    typeof observation.execution.adapterProducerId !== "string" ||
    typeof observation.execution.executableDigest !== "string" ||
    typeof observation.execution.protocolDigest !== "string" ||
    typeof observation.execution.actualModelId !== "string" ||
    typeof observation.execution.actualSettingsDigest !== "string" ||
    typeof observation.execution.sessionId !== "string" ||
    observation.execution.sessionId.length === 0 ||
    observation.execution.newSession !== true ||
    (observation.aaPairId !== undefined &&
    typeof observation.aaPairId !== "string") ||
    (observation.aaVariant !== undefined &&
    !["A1", "A2"].includes(observation.aaVariant))
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Evaluation observation schema or numeric bounds are invalid"
    );
  }
  return success(observation as EvaluationObservation);
}

function overlapRecall(
  expected: readonly string[],
  observed: readonly string[]
): number {
  if (expected.length === 0) return 1;
  const values = new Set(observed);
  return expected.filter((item) => values.has(item)).length / expected.length;
}

export function scoreObservation(
  observation: EvaluationObservation,
  testCase: EvaluationCase
): EvaluationScore {
  return {
    trialId: observation.trialId,
    caseId: observation.caseId,
    arm: observation.arm,
    taskSuccess: observation.taskSuccess ? 1 : 0,
    visibleEvidenceRecall: overlapRecall(
      testCase.expectedEvidenceIds,
      observation.visibleEvidenceIds
    ),
    recoverableEvidenceRecall: overlapRecall(
      testCase.expectedEvidenceIds,
      [
        ...observation.visibleEvidenceIds,
        ...observation.recoverableEvidenceIds
      ]
    ),
    distinctFailureRecall: overlapRecall(
      testCase.expectedFailureIds,
      observation.distinctFailureIds
    ),
    citationRecall: overlapRecall(
      testCase.expectedCitations,
      observation.citations
    ),
    unsupportedClaims: observation.unsupportedClaims,
    contradictions: observation.contradictions,
    abstentionScore: observation.abstained
      ? testCase.allowAbstention
        ? 1
        : 0
      : 1,
    totalLatencyMs:
      observation.preparationLatencyMs +
      observation.reviewLatencyMs +
      observation.handoffLatencyMs +
      observation.modelLatencyMs +
      observation.retrievalLatencyMs,
    retrievalTokens: observation.retrievalTokens,
    retrievalCalls: observation.retrievalCalls,
    decisions: observation.decisions,
    tools: observation.tools,
    permissions: observation.permissions
  };
}

function composite(score: EvaluationScore): number {
  return (
    score.taskSuccess * 0.35 +
    score.visibleEvidenceRecall * 0.15 +
    score.recoverableEvidenceRecall * 0.15 +
    score.distinctFailureRecall * 0.1 +
    score.citationRecall * 0.1 +
    score.abstentionScore * 0.05 -
    score.unsupportedClaims * 0.05 -
    score.contradictions * 0.1
  );
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      (values.length - 1)
  );
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

function bootstrap(
  differences: readonly number[],
  seed: number,
  samples = 2_000
): readonly [number, number] {
  if (differences.length === 0) return [0, 0];
  const next = random(seed);
  const means: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const values = Array.from(
      { length: differences.length },
      () => differences[Math.floor(next() * differences.length)] as number
    );
    means.push(mean(values));
  }
  means.sort((left, right) => left - right);
  return [
    means[Math.floor(samples * 0.025)] ?? 0,
    means[Math.floor(samples * 0.975)] ?? 0
  ];
}

export function createReplayManifest(input: {
  readonly suiteId: string;
  readonly cases: readonly EvaluationCase[];
  readonly settings: EvaluationRunSettings;
  readonly seed: number;
  readonly liveOptIn: boolean;
  readonly trialsPerArm?: number;
  readonly includeTruncation?: boolean;
  readonly createdAt?: string;
}): EvaluationReplayManifest {
  const trialsPerArm = input.trialsPerArm ?? 3;
  const arms = input.includeTruncation
    ? (["original", "prepared", "truncation"] as const)
    : (["original", "prepared"] as const);
  const settingsDigest = canonicalJsonDigest(input.settings);
  const blocks = input.cases.flatMap((testCase, caseIndex) =>
    Array.from({ length: trialsPerArm }, (_, index) => {
      const orderedArms =
        (input.seed + caseIndex + index) % 2 === 0
          ? [...arms]
          : [
              arms[1] as (typeof arms)[number],
              arms[0] as (typeof arms)[number],
              ...arms.slice(2)
            ];
      return orderedArms.map((arm) => ({
        trialId: deterministicUuid(
          `${input.suiteId}:${testCase.caseId}:${arm}:${index + 1}:${input.seed}`
        ),
        caseId: testCase.caseId,
        trialNumber: index + 1,
        arm,
        settings: input.settings,
        sessionConstraintDigest: canonicalJsonDigest({
          caseId: testCase.caseId,
          trial: index + 1,
          settingsDigest
        })
      }));
    })
  );
  const next = random(input.seed);
  for (let index = blocks.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    [blocks[index], blocks[swap]] = [
      blocks[swap] as (typeof blocks)[number],
      blocks[index] as (typeof blocks)[number]
    ];
  }
  const plans = blocks.flat();
  const unsigned = {
    formatVersion: 1 as const,
    suiteId: input.suiteId,
    seed: input.seed,
    liveOptIn: input.liveOptIn,
    trialsPerArm,
    cases: input.cases,
    plans,
    createdAt: input.createdAt ?? new Date().toISOString(),
    producer: producer()
  };
  return { ...unsigned, digest: canonicalJsonDigest(unsigned) };
}

function pairKey(score: EvaluationScore): string {
  return `${score.caseId}:${score.trialId}`;
}

export async function runPairedEvaluation(input: {
  readonly manifest: EvaluationReplayManifest;
  readonly runner: EvaluationArmRunner;
  readonly aaObservations?: readonly EvaluationObservation[];
  readonly minCases?: number;
  readonly minTrialsPerArm?: number;
}): Promise<Result<PairedEvaluationReport>> {
  const manifest = deepFreeze(structuredClone(input.manifest));
  const manifestValidation = validateReplayManifest(manifest);
  if (!manifestValidation.ok) return manifestValidation;
  if (!manifest.liveOptIn) {
    return failure(
      "INVALID_ARGUMENT",
      "Live paired evaluation requires explicit opt-in"
    );
  }
  const observations: EvaluationObservation[] = [];
  const sessionIds = new Set<string>();
  for (const plan of manifest.plans) {
    const testCase = manifest.cases.find(
      (candidate) => candidate.caseId === plan.caseId
    );
    if (testCase === undefined) {
      return failure("INTEGRITY_ERROR", "Replay plan references unknown case");
    }
    const observation = await input.runner.run(plan, testCase);
    if (!observation.ok) return observation;
    const parsedObservation = parseEvaluationObservation(observation.value);
    if (!parsedObservation.ok) return parsedObservation;
    if (
      parsedObservation.value.trialId !== plan.trialId ||
      parsedObservation.value.caseId !== plan.caseId ||
      parsedObservation.value.arm !== plan.arm ||
      parsedObservation.value.modelId !== plan.settings.modelId ||
      parsedObservation.value.settingsDigest !==
        canonicalJsonDigest(plan.settings) ||
      parsedObservation.value.sessionConstraintDigest !==
        plan.sessionConstraintDigest ||
      parsedObservation.value.execution.adapterProducerId !==
        plan.settings.adapterId ||
      parsedObservation.value.execution.actualModelId !==
        plan.settings.modelId ||
      parsedObservation.value.execution.actualSettingsDigest !==
        canonicalJsonDigest(plan.settings) ||
      parsedObservation.value.execution.newSession !== true ||
      !/^[A-Za-z0-9_-]{43}$/.test(
        parsedObservation.value.execution.executableDigest
      ) ||
      !/^[A-Za-z0-9_-]{43}$/.test(
        parsedObservation.value.execution.protocolDigest
      ) ||
      sessionIds.has(parsedObservation.value.execution.sessionId)
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Evaluation observation violates matched trial constraints"
      );
    }
    sessionIds.add(parsedObservation.value.execution.sessionId);
    observations.push(parsedObservation.value);
  }
  const scores = observations.map((observation) =>
    scoreObservation(
      observation,
      manifest.cases.find(
        (testCase) => testCase.caseId === observation.caseId
      ) as EvaluationCase
    )
  );
  const byCaseTrial = new Map<
    string,
    { original?: EvaluationScore; prepared?: EvaluationScore }
  >();
  for (const score of scores) {
    if (score.arm === "truncation") continue;
    const plan = manifest.plans.find(
      (candidate) => candidate.trialId === score.trialId
    );
    const key = `${score.caseId}:${plan?.trialNumber ?? 0}`;
    const pair = byCaseTrial.get(key) ?? {};
    pair[score.arm] = score;
    byCaseTrial.set(key, pair);
  }
  const differences: number[] = [];
  let preparedWins = 0;
  let originalWins = 0;
  let ties = 0;
  for (const pair of byCaseTrial.values()) {
    if (pair.original === undefined || pair.prepared === undefined) {
      return failure(
        "INTEGRITY_ERROR",
        "Evaluation report is missing a complete original/prepared pair"
      );
    }
    const difference = composite(pair.prepared) - composite(pair.original);
    differences.push(difference);
    if (pair.prepared.taskSuccess > pair.original.taskSuccess) preparedWins += 1;
    else if (pair.prepared.taskSuccess < pair.original.taskSuccess) {
      originalWins += 1;
    } else ties += 1;
  }
  const originalScores = scores
    .filter((score) => score.arm === "original")
    .map(composite);
  const preparedScores = scores
    .filter((score) => score.arm === "prepared")
    .map(composite);
  const deviation = standardDeviation(differences);
  const minCases = input.minCases ?? 3;
  const minTrials = input.minTrialsPerArm ?? 3;
  const reportingFloorMet =
    manifest.cases.length >= minCases &&
    manifest.trialsPerArm >= minTrials;
  const aaPairs = new Map<
    string,
    {
      caseId: string;
      sessionConstraintDigest: string;
      A1?: EvaluationScore;
      A2?: EvaluationScore;
    }
  >();
  const aaSessionIds = new Set(sessionIds);
  for (const observation of input.aaObservations ?? []) {
    if (
      observation.aaPairId === undefined ||
      observation.aaVariant === undefined
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "A/A observations require aaPairId and aaVariant"
      );
    }
    const testCase = manifest.cases.find(
      (candidate) => candidate.caseId === observation.caseId
    );
    if (testCase === undefined) {
      return failure("INTEGRITY_ERROR", "A/A observation references unknown case");
    }
    const parsed = parseEvaluationObservation(observation);
    if (!parsed.ok) return parsed;
    const plan = manifest.plans.find(
      (candidate) => candidate.trialId === parsed.value.trialId
    );
    if (
      plan === undefined ||
      plan.arm !== "original" ||
      parsed.value.arm !== "original" ||
      parsed.value.modelId !== plan.settings.modelId ||
      parsed.value.settingsDigest !== canonicalJsonDigest(plan.settings) ||
      parsed.value.sessionConstraintDigest !==
        plan.sessionConstraintDigest ||
      parsed.value.execution.adapterProducerId !==
        plan.settings.adapterId ||
      parsed.value.execution.actualModelId !== plan.settings.modelId ||
      parsed.value.execution.actualSettingsDigest !==
        canonicalJsonDigest(plan.settings) ||
      !/^[A-Za-z0-9_-]{43}$/.test(
        parsed.value.execution.executableDigest
      ) ||
      !/^[A-Za-z0-9_-]{43}$/.test(
        parsed.value.execution.protocolDigest
      ) ||
      aaSessionIds.has(parsed.value.execution.sessionId)
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "A/A observation violates matched trial constraints"
      );
    }
    aaSessionIds.add(parsed.value.execution.sessionId);
    const pair = aaPairs.get(observation.aaPairId) ?? {
      caseId: parsed.value.caseId,
      sessionConstraintDigest: parsed.value.sessionConstraintDigest
    };
    if (
      pair.caseId !== parsed.value.caseId ||
      pair.sessionConstraintDigest !==
        parsed.value.sessionConstraintDigest ||
      pair[observation.aaVariant] !== undefined
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "A/A pair is duplicated or unmatched"
      );
    }
    pair[observation.aaVariant] = scoreObservation(
      parsed.value,
      testCase
    );
    aaPairs.set(observation.aaPairId, pair);
  }
  const aaDifferences: number[] = [];
  for (const pair of aaPairs.values()) {
    if (pair.A1 === undefined || pair.A2 === undefined) {
      return failure("INTEGRITY_ERROR", "Incomplete A/A pair");
    }
    aaDifferences.push(composite(pair.A2) - composite(pair.A1));
  }
  const differenceMean = mean(differences);
  const zeroVariance = Math.abs(deviation) < 1e-12;
  const effectSizeDz =
    zeroVariance && Math.abs(differenceMean) >= 1e-12
      ? null
      : zeroVariance
        ? 0
        : differenceMean / deviation;
  const effectWarnings =
    effectSizeDz === null
      ? ["Effect size dz is undefined because paired variance is zero"]
      : [];
  return success({
    manifestDigest: manifest.digest,
    scores,
    originalMean: mean(originalScores),
    preparedMean: mean(preparedScores),
    meanDifference: differenceMean,
    effectSizeDz,
    bootstrap95: bootstrap(differences, manifest.seed),
    discordance: { preparedWins, originalWins, ties },
    ...(aaDifferences.length === 0
      ? {}
      : {
          aaNoise: mean(
            aaDifferences.map((difference) => Math.abs(difference))
          )
        }),
    reportingFloorMet,
    warnings: [
      ...effectWarnings,
      ...(reportingFloorMet
      ? []
      : [
          `Reporting floor requires at least ${minCases} cases and ${minTrials} trials per arm`
        ])
    ],
    producer: producer()
  });
}

export function evaluationJson(
  report: PairedEvaluationReport
): string {
  return canonicalJson(report);
}

export function evaluationMarkdown(
  report: PairedEvaluationReport
): string {
  return [
    "# Paired evaluation",
    "",
    `- Manifest: \`${report.manifestDigest}\``,
    `- Original mean: ${report.originalMean.toFixed(4)}`,
    `- Prepared mean: ${report.preparedMean.toFixed(4)}`,
    `- Mean difference: ${report.meanDifference.toFixed(4)}`,
    `- Effect size dz: ${report.effectSizeDz === null ? "undefined" : report.effectSizeDz.toFixed(4)}`,
    `- Bootstrap 95%: [${report.bootstrap95[0].toFixed(4)}, ${report.bootstrap95[1].toFixed(4)}]`,
    `- Discordance: prepared ${report.discordance.preparedWins}, original ${report.discordance.originalWins}, ties ${report.discordance.ties}`,
    `- Reporting floor: ${report.reportingFloorMet ? "met" : "not met"}`,
    "",
    "| Trial | Case | Arm | Success | Visible recall | Recoverable recall | Failures | Citations | Unsupported | Contradictions | Latency ms |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.scores.map(
      (score) =>
        `| ${score.trialId} | ${score.caseId} | ${score.arm} | ${score.taskSuccess} | ${score.visibleEvidenceRecall.toFixed(3)} | ${score.recoverableEvidenceRecall.toFixed(3)} | ${score.distinctFailureRecall.toFixed(3)} | ${score.citationRecall.toFixed(3)} | ${score.unsupportedClaims} | ${score.contradictions} | ${score.totalLatencyMs} |`
    )
  ].join("\n");
}

export function evaluationCsv(
  report: PairedEvaluationReport
): string {
  const header =
    "trial_id,case_id,arm,task_success,visible_recall,recoverable_recall,failure_recall,citation_recall,unsupported_claims,contradictions,latency_ms,retrieval_tokens,retrieval_calls,decisions,tools,permissions";
  return [
    header,
    ...report.scores.map((score) =>
      [
        score.trialId,
        score.caseId,
        score.arm,
        score.taskSuccess,
        score.visibleEvidenceRecall,
        score.recoverableEvidenceRecall,
        score.distinctFailureRecall,
        score.citationRecall,
        score.unsupportedClaims,
        score.contradictions,
        score.totalLatencyMs,
        score.retrievalTokens,
        score.retrievalCalls,
        score.decisions,
        score.tools,
        score.permissions
      ].join(",")
    )
  ].join("\n");
}

export const evaluationHarnessProducer = Object.freeze({
  metadata: producer()
});
