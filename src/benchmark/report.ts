import { readFileSync } from "node:fs";

import type {
  BenchmarkModelReport,
  BenchmarkCaseContract,
  BenchmarkReport,
  BenchmarkRunState,
  BenchmarkTrialRecord,
  BenchmarkTrialScore
} from "./contracts.js";
import {
  loadBenchmarkSuite,
  loadCaseContract,
  locateBenchmarkRun,
  loadRunState
} from "./storage.js";
import {
  canonicalJson,
  canonicalJsonDigest
} from "../core/canonical.js";
import { sha256Base64Url } from "../core/hash.js";
import { failure, success, type Result } from "../core/result.js";
import {
  benchmarkPathFromRelative,
  relativeToBenchmarkRoot,
  resolveInside,
  writeBytesAtomic
} from "./io.js";

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) /
        values.length;
}

function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(
    values.reduce(
      (sum, value) => sum + (value - average) ** 2,
      0
    ) /
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
  values: readonly number[],
  seed: number,
  samples = 2_000
): readonly [number, number] {
  if (values.length === 0) return [0, 0];
  const next = random(seed);
  const results: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    results.push(
      mean(
        Array.from(
          { length: values.length },
          () =>
            values[
              Math.floor(next() * values.length)
            ] as number
        )
      )
    );
  }
  results.sort((left, right) => left - right);
  return [
    results[Math.floor(samples * 0.025)] ?? 0,
    results[Math.floor(samples * 0.975)] ?? 0
  ];
}

function composite(score: BenchmarkTrialScore): number {
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

function recall(
  observed: readonly string[],
  recoverable: readonly string[]
): number {
  const expected = recoverable;
  if (expected.length === 0) return 1;
  const values = new Set(observed);
  return (
    expected.filter((item) => values.has(item)).length /
    expected.length
  );
}

function score(
  plan: BenchmarkRunState["manifest"]["plans"][number],
  record: BenchmarkTrialRecord,
  contract: BenchmarkCaseContract
): BenchmarkTrialScore | undefined {
  const observation = record.observation;
  if (observation === undefined) return undefined;
  return {
    trialId: plan.trialId,
    caseId: plan.caseId,
    modelId: plan.modelId,
    arm: plan.arm,
    trialNumber: plan.trialNumber,
    taskSuccess: observation.taskSuccess ? 1 : 0,
    visibleEvidenceRecall: recall(
      observation.visibleFactIds,
      contract.requiredFacts
        .filter((fact) => fact.required)
        .map((fact) => fact.factId)
    ),
    recoverableEvidenceRecall: recall(
      observation.recoverableFactIds,
      contract.requiredFacts
        .filter((fact) => fact.required)
        .map((fact) => fact.factId)
    ),
    distinctFailureRecall: recall(
      observation.distinctFailureIds,
      contract.requiredFacts
        .filter(
          (fact) => fact.required && fact.kind === "failure"
        )
        .map((fact) => fact.factId)
    ),
    citationRecall: recall(
      observation.citations,
      contract.requiredFacts
        .filter(
          (fact) => fact.required && fact.kind === "citation"
        )
        .map((fact) => fact.factId)
    ),
    unsupportedClaims: observation.unsupportedClaims,
    contradictions: observation.contradictions,
    abstentionScore: contract.allowAbstention
      ? observation.abstained
        ? 1
        : 0
      : observation.abstained
        ? 0
        : 1,
    retrievalTokens: observation.retrievalTokens,
    retrievalCalls: observation.retrievalCalls,
    retrievalLatencyMs: observation.retrievalLatencyMs,
    preparationLatencyMs: observation.preparationLatencyMs,
    reviewLatencyMs: observation.reviewLatencyMs,
    handoffLatencyMs: observation.handoffLatencyMs,
    modelLatencyMs: observation.modelLatencyMs,
    inputTokens: observation.inputTokens,
    outputTokens: observation.outputTokens,
    decisions: observation.decisions,
    tools: observation.tools,
    permissions: observation.permissions
  };
}

function jaccard(
  left: readonly string[],
  right: readonly string[]
): number {
  const first = new Set(left);
  const second = new Set(right);
  const union = new Set([...first, ...second]);
  if (union.size === 0) return 1;
  return (
    [...first].filter((item) => second.has(item)).length /
    union.size
  );
}

function selfAgreement(
  state: BenchmarkRunState,
  modelId: string
): number | null {
  const groups = new Map<string, readonly string[][]>();
  for (const plan of state.manifest.plans.filter(
    (item) =>
      item.modelId === modelId && item.arm === "original"
  )) {
    const record = state.trials[plan.trialId];
    if (record?.observation === undefined) continue;
    const values = [
      ...(groups.get(plan.caseId) ?? []),
      [...record.observation.visibleFactIds]
    ];
    groups.set(plan.caseId, values);
  }
  const agreements: number[] = [];
  for (const observations of groups.values()) {
    for (let left = 0; left < observations.length; left += 1) {
      for (
        let right = left + 1;
        right < observations.length;
        right += 1
      ) {
        agreements.push(
          jaccard(
            observations[left] as readonly string[],
            observations[right] as readonly string[]
          )
        );
      }
    }
  }
  return agreements.length === 0 ? null : mean(agreements);
}

function modelReport(
  state: BenchmarkRunState,
  modelId: string,
  contracts: ReadonlyMap<string, BenchmarkCaseContract>
): BenchmarkModelReport {
  const scores = state.manifest.plans
    .filter((plan) => plan.modelId === modelId)
    .flatMap((plan) => {
      const contract = contracts.get(plan.caseId);
      const record = state.trials[plan.trialId];
      const value =
        contract === undefined || record === undefined
          ? undefined
          : score(plan, record, contract);
      return value === undefined ? [] : [value];
    });
  const pairs = new Map<
    string,
    {
      original?: BenchmarkTrialScore;
      prepared?: BenchmarkTrialScore;
    }
  >();
  for (const value of scores) {
    if (
      value.arm !== "original" &&
      value.arm !== "prepared"
    ) {
      continue;
    }
    const key = `${value.caseId}:${value.trialNumber}`;
    const pair = pairs.get(key) ?? {};
    pair[value.arm] = value;
    pairs.set(key, pair);
  }
  const differences: number[] = [];
  let completePairCount = 0;
  let preparedWins = 0;
  let originalWins = 0;
  let ties = 0;
  for (const pair of pairs.values()) {
    if (
      pair.original === undefined ||
      pair.prepared === undefined
    ) {
      continue;
    }
    completePairCount += 1;
    const difference =
      composite(pair.prepared) - composite(pair.original);
    differences.push(difference);
    if (difference > 0) preparedWins += 1;
    else if (difference < 0) originalWins += 1;
    else ties += 1;
  }
  const original = scores
    .filter((value) => value.arm === "original")
    .map(composite);
  const prepared = scores
    .filter((value) => value.arm === "prepared")
    .map(composite);
  const deviation = standardDeviation(differences);
  const differenceMean = mean(differences);
  const effectSizeDz =
    deviation === 0
      ? differenceMean === 0
        ? 0
        : null
      : differenceMean / deviation;
  const completePairsPerCase = new Map<string, number>();
  for (const [key, pair] of pairs) {
    if (
      pair.original !== undefined &&
      pair.prepared !== undefined
    ) {
      const caseId = key.slice(0, key.lastIndexOf(":"));
      completePairsPerCase.set(
        caseId,
        (completePairsPerCase.get(caseId) ?? 0) + 1
      );
    }
  }
  const completePairedCaseCount = [
    ...completePairsPerCase.values()
  ].filter((count) => count >= 3).length;
  const reportingFloorMet =
    completePairedCaseCount >= 3;
  const terminalFailures = state.manifest.plans.filter((plan) => {
    const record = state.trials[plan.trialId];
    return (
      plan.modelId === modelId &&
      record !== undefined &&
      ["failed", "timeout", "interrupted", "blocked"].includes(
        record.status
      )
    );
  }).length;
  return {
    modelId,
    scores,
    trialStatusCounts: Object.fromEntries(
      [
        "pending",
        "running",
        "completed",
        "failed",
        "timeout",
        "interrupted",
        "blocked",
        "not-applicable"
      ].map((status) => [
        status,
        state.manifest.plans.filter(
          (plan) =>
            plan.modelId === modelId &&
            state.trials[plan.trialId]?.status === status
        ).length
      ])
    ) as BenchmarkModelReport["trialStatusCounts"],
    completePairCount,
    completePairedCaseCount,
    aaSelfAgreement: selfAgreement(state, modelId),
    originalMean: mean(original),
    preparedMean: mean(prepared),
    meanDifference: differenceMean,
    effectSizeDz,
    bootstrap95: bootstrap(
      differences,
      state.manifest.seed
    ),
    discordance: {
      preparedWins,
      originalWins,
      ties
    },
    reportingFloorMet,
    warnings: [
      ...(effectSizeDz === null
        ? [
            "Effect size is undefined because paired variance is zero with a nonzero mean"
          ]
        : []),
      ...(reportingFloorMet
        ? []
        : [
            "Reporting floor requires at least three paired cases and three trials per arm"
          ]),
      ...(completePairCount === pairs.size
        ? []
        : [
            `${pairs.size - completePairCount} A/B pair(s) were incomplete and excluded`
          ]),
      ...(terminalFailures === 0
        ? []
        : [
            `${terminalFailures} trial(s) ended in failure, timeout, interruption, or security block`
          ])
    ]
  };
}

function validateResponseFiles(
  root: string,
  state: BenchmarkRunState
): Result<void> {
  for (const record of Object.values(state.trials)) {
    if (
      record.responsePath === undefined ||
      record.responseSha256 === undefined ||
      record.responseByteLength === undefined
    ) {
      continue;
    }
    const path = resolveInside(root, record.responsePath);
    if (!path.ok) return path;
    try {
      const bytes = readFileSync(path.value);
      if (
        bytes.length !== record.responseByteLength ||
        sha256Base64Url(bytes) !== record.responseSha256
      ) {
        return failure(
          "INTEGRITY_ERROR",
          "Benchmark response changed after execution"
        );
      }
    } catch {
      return failure(
        "INTEGRITY_ERROR",
        "Benchmark response is missing"
      );
    }
  }
  return success(undefined);
}

export function buildBenchmarkReport(
  runId: string
): Result<{
  readonly root: string;
  readonly state: BenchmarkRunState;
  readonly report: BenchmarkReport;
}> {
  const located = locateBenchmarkRun(runId);
  if (!located.ok) return located;
  const state = loadRunState(located.value);
  if (!state.ok || state.value === undefined) {
    return state.ok
      ? failure(
          "HANDLE_NOT_FOUND",
          "Benchmark run state is missing"
        )
      : state;
  }
  if (
    !["completed", "completed-with-failures"].includes(
      state.value.status
    ) ||
    state.value.manifest.plans.some((plan) => {
      const record = state.value?.trials[plan.trialId];
      return (
        record === undefined ||
        ["pending", "running"].includes(record.status)
      );
    })
  ) {
    return failure(
      "INVALID_ARGUMENT",
      "Benchmark reports require a terminal run with every trial accounted for"
    );
  }
  const responses = validateResponseFiles(
    located.value,
    state.value
  );
  if (!responses.ok) return responses;
  const suitePath = benchmarkPathFromRelative(
    state.value.suitePath
  );
  if (!suitePath.ok) return suitePath;
  const suite = loadBenchmarkSuite(suitePath.value);
  if (
    !suite.ok ||
    suite.value.suite.digest !==
      state.value.manifest.suiteDigest
  ) {
    return suite.ok
      ? failure(
          "INTEGRITY_ERROR",
          "Benchmark report suite digest mismatch"
        )
      : suite;
  }
  const contracts = new Map<string, BenchmarkCaseContract>();
  for (const item of suite.value.suite.cases) {
    const contract = loadCaseContract(suite.value.root, item);
    if (!contract.ok) return contract;
    contracts.set(item.caseId, contract.value);
  }
  const modelIds = [
    ...new Set(
      state.value.manifest.plans
        .filter(
          (plan) => !plan.helper
        )
        .map((plan) => plan.modelId)
    )
  ];
  const helperPlans = state.value.manifest.plans.filter(
    (plan) => plan.helper
  );
  const helperStatusCounts = Object.fromEntries(
    [
      "pending",
      "running",
      "completed",
      "failed",
      "timeout",
      "interrupted",
      "blocked",
      "not-applicable"
    ].map((status) => [
      status,
      helperPlans.filter(
        (plan) =>
          state.value?.trials[plan.trialId]?.status === status
      ).length
    ])
  ) as NonNullable<BenchmarkReport["helper"]>["statusCounts"];
  const deterministicAdvice = [
    ...contracts.values()
  ].flatMap((contract) =>
    contract.deterministicAdvice === undefined
      ? []
      : [
          {
            caseId: contract.caseId,
            digest: canonicalJsonDigest(
              contract.deterministicAdvice
            ),
            advice: contract.deterministicAdvice
          }
        ]
  );
  const unsigned = {
    formatVersion: 1 as const,
    benchmarkRunId: state.value.benchmarkRunId,
    manifestDigest: state.value.manifest.digest,
    suiteDigest: state.value.manifest.suiteDigest,
    models: modelIds.map((modelId) =>
      modelReport(
        state.value as BenchmarkRunState,
        modelId,
        contracts
      )
    ),
    ...(helperPlans.length === 0
      ? {}
      : {
          helper: {
            ...(state.value.manifest.helperModelId === undefined
              ? {}
              : {
                  modelId:
                    state.value.manifest.helperModelId
                }),
            statusCounts: helperStatusCounts,
            warnings:
              state.value.manifest.helperModelId === undefined
                ? [
                    "Luna helper model was not configured; helper trials are not applicable"
                  ]
                : []
          }
        }),
    deterministicAdvice,
    detailedRunPath: relativeToBenchmarkRoot(located.value),
    contentSafe: true as const
  };
  return success({
    root: located.value,
    state: state.value,
    report: {
      ...unsigned,
      digest: canonicalJsonDigest(unsigned)
    }
  });
}

export function benchmarkReportJson(
  report: BenchmarkReport
): string {
  return canonicalJson(report);
}

export function benchmarkReportMarkdown(
  report: BenchmarkReport
): string {
  const lines = [
    "# Context Overflow benchmark report",
    "",
    `- Run: \`${report.benchmarkRunId}\``,
    `- Manifest: \`${report.manifestDigest}\``,
    `- Suite: \`${report.suiteDigest}\``,
    `- Detailed local run: \`${report.detailedRunPath}\``,
    ""
  ];
  for (const model of report.models) {
    lines.push(
      `## ${model.modelId}`,
      "",
      `- A/A self agreement: ${
        model.aaSelfAgreement === null
          ? "N/A"
          : model.aaSelfAgreement.toFixed(4)
      }`,
      `- Original mean: ${model.originalMean.toFixed(4)}`,
      `- Prepared mean: ${model.preparedMean.toFixed(4)}`,
      `- Paired mean difference: ${model.meanDifference.toFixed(4)}`,
      `- Effect size dz: ${
        model.effectSizeDz === null
          ? "undefined"
          : model.effectSizeDz.toFixed(4)
      }`,
      `- Seeded 95% interval: [${model.bootstrap95[0].toFixed(
        4
      )}, ${model.bootstrap95[1].toFixed(4)}]`,
      `- Discordance: prepared ${model.discordance.preparedWins}, original ${model.discordance.originalWins}, ties ${model.discordance.ties}`,
      `- Trial statuses: ${Object.entries(
        model.trialStatusCounts
      )
        .map(([status, count]) => `${status}=${count}`)
        .join(", ")}`,
      `- Complete A/B pairs: ${model.completePairCount} across ${model.completePairedCaseCount} floor-qualified cases`,
      `- Reporting floor: ${
        model.reportingFloorMet ? "met" : "not met"
      }`,
      "",
      "| Case | Arm | Trial | Success | Visible | Recoverable | Failures | Citations | Abstention | Input tokens | Output tokens | Model ms | Tools | Permissions |",
      "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
      ...model.scores.map(
        (value) =>
          `| ${value.caseId} | ${value.arm} | ${value.trialNumber} | ${value.taskSuccess} | ${value.visibleEvidenceRecall.toFixed(
            3
          )} | ${value.recoverableEvidenceRecall.toFixed(
            3
          )} | ${value.distinctFailureRecall.toFixed(
            3
          )} | ${value.citationRecall.toFixed(
            3
          )} | ${value.abstentionScore} | ${displayMetric(
            value.inputTokens
          )} | ${displayMetric(
            value.outputTokens
          )} | ${value.modelLatencyMs.toFixed(
            1
          )} | ${value.tools} | ${value.permissions} |`
      ),
      ""
    );
    if (model.warnings.length > 0) {
      lines.push(
        ...model.warnings.map((warning) => `- Warning: ${warning}`),
        ""
      );
    }
    if (report.helper !== undefined) {
      lines.push(
        "## Optional helper",
        "",
        `- Model: ${report.helper.modelId ?? "not configured"}`,
        `- Statuses: ${Object.entries(report.helper.statusCounts)
          .map(([status, count]) => `${status}=${count}`)
          .join(", ")}`,
        ...report.helper.warnings.map(
          (warning) => `- Warning: ${warning}`
        ),
        ""
      );
    }
    if (report.deterministicAdvice.length > 0) {
      lines.push(
        "## Deterministic model advice",
        "",
        ...report.deterministicAdvice.map(
          (item) =>
            `- ${item.caseId}: \`${item.digest}\` ${JSON.stringify(
              item.advice
            )}`
        ),
        ""
      );
    }
  }
  return lines.join("\n");
}

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function displayMetric(value: number | null): string {
  return value === null ? "N/A" : String(value);
}

export function benchmarkReportCsv(
  report: BenchmarkReport
): string {
  const header = [
    "model",
    "case",
    "arm",
    "trial",
    "task_success",
    "visible_recall",
    "recoverable_recall",
    "failure_recall",
    "citation_recall",
    "unsupported_claims",
    "contradictions",
    "abstention",
    "retrieval_tokens",
    "retrieval_calls",
    "retrieval_latency_ms",
    "preparation_latency_ms",
    "review_latency_ms",
    "handoff_latency_ms",
    "model_latency_ms",
    "input_tokens",
    "output_tokens",
    "decisions",
    "tools",
    "permissions"
  ];
  return [
    header.map(csvCell).join(","),
    ...report.models.flatMap((model) =>
      model.scores.map((value) =>
        [
          model.modelId,
          value.caseId,
          value.arm,
          value.trialNumber,
          value.taskSuccess,
          value.visibleEvidenceRecall,
          value.recoverableEvidenceRecall,
          value.distinctFailureRecall,
          value.citationRecall,
          value.unsupportedClaims,
          value.contradictions,
          value.abstentionScore,
          value.retrievalTokens,
          value.retrievalCalls,
          value.retrievalLatencyMs,
          value.preparationLatencyMs,
          value.reviewLatencyMs,
          value.handoffLatencyMs,
          value.modelLatencyMs,
          value.inputTokens,
          value.outputTokens,
          value.decisions,
          value.tools,
          value.permissions
        ]
          .map(csvCell)
          .join(",")
      )
    )
  ].join("\n");
}

export function writeBenchmarkReport(
  runId: string,
  format: "json" | "markdown" | "csv"
): Result<{
  readonly content: string;
  readonly path: string;
  readonly report: BenchmarkReport;
}> {
  const built = buildBenchmarkReport(runId);
  if (!built.ok) return built;
  const content =
    format === "json"
      ? benchmarkReportJson(built.value.report)
      : format === "markdown"
        ? benchmarkReportMarkdown(built.value.report)
        : benchmarkReportCsv(built.value.report);
  const extension =
    format === "markdown" ? "md" : format;
  const relativePath = `reports/shareable.${extension}`;
  try {
    const bytes = Buffer.from(`${content}\n`, "utf8");
    const written = writeBytesAtomic(
      built.value.root,
      relativePath,
      bytes
    );
    if (!written.ok) return written;
    return success({
      content,
      path: relativePath,
      report: built.value.report
    });
  } catch (error) {
    return failure("IO_ERROR", "Unable to write benchmark report", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}
