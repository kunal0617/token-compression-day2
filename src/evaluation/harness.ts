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
  const plans = input.cases.flatMap((testCase) =>
    arms.flatMap((arm) =>
      Array.from({ length: trialsPerArm }, (_, index) => ({
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
      }))
    )
  );
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
  if (!input.manifest.liveOptIn) {
    return failure(
      "INVALID_ARGUMENT",
      "Live paired evaluation requires explicit opt-in"
    );
  }
  const observations: EvaluationObservation[] = [];
  for (const plan of input.manifest.plans) {
    const testCase = input.manifest.cases.find(
      (candidate) => candidate.caseId === plan.caseId
    );
    if (testCase === undefined) {
      return failure("INTEGRITY_ERROR", "Replay plan references unknown case");
    }
    const observation = await input.runner.run(plan, testCase);
    if (!observation.ok) return observation;
    if (
      observation.value.trialId !== plan.trialId ||
      observation.value.caseId !== plan.caseId ||
      observation.value.arm !== plan.arm ||
      observation.value.modelId !== plan.settings.modelId ||
      observation.value.settingsDigest !==
        canonicalJsonDigest(plan.settings) ||
      observation.value.sessionConstraintDigest !==
        plan.sessionConstraintDigest
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Evaluation observation violates matched trial constraints"
      );
    }
    observations.push(observation.value);
  }
  const scores = observations.map((observation) =>
    scoreObservation(
      observation,
      input.manifest.cases.find(
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
    const plan = input.manifest.plans.find(
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
    if (pair.original === undefined || pair.prepared === undefined) continue;
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
    input.manifest.cases.length >= minCases &&
    input.manifest.trialsPerArm >= minTrials;
  const aaScores =
    input.aaObservations?.map((observation) =>
      scoreObservation(
        observation,
        input.manifest.cases.find(
          (testCase) => testCase.caseId === observation.caseId
        ) as EvaluationCase
      )
    ) ?? [];
  return success({
    manifestDigest: input.manifest.digest,
    scores,
    originalMean: mean(originalScores),
    preparedMean: mean(preparedScores),
    meanDifference: mean(differences),
    effectSizeDz: deviation === 0 ? 0 : mean(differences) / deviation,
    bootstrap95: bootstrap(differences, input.manifest.seed),
    discordance: { preparedWins, originalWins, ties },
    ...(aaScores.length === 0
      ? {}
      : { aaNoise: standardDeviation(aaScores.map(composite)) }),
    reportingFloorMet,
    warnings: reportingFloorMet
      ? []
      : [
          `Reporting floor requires at least ${minCases} cases and ${minTrials} trials per arm`
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
    `- Effect size dz: ${report.effectSizeDz.toFixed(4)}`,
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

