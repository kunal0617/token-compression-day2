import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

import type {
  AgentRunScopeAuthority,
  AgentSendReceipt,
  ApprovedAgentSendRequest
} from "../contracts/agent.js";
import type {
  ApprovalDecision,
  ApprovalPayloadRole,
  PermissionEnvelope
} from "../contracts/approval.js";
import type { ApprovedReviewPayload } from "../contracts/tui.js";
import type { ProducerMetadata } from "../contracts/providers.js";
import type { Result } from "../core/result.js";
import {
  failure,
  success
} from "../core/result.js";
import {
  canonicalJson,
  canonicalJsonDigest
} from "../core/canonical.js";
import {
  sha256Base64Url
} from "../core/hash.js";
import { agentReadScopeDigest } from "../core/read-scope.js";
import {
  approveReviewSubject,
  reviewSubjectProvider,
  validateApproval
} from "../approval/review.js";
import { builtinRuntime } from "../registry/builtins.js";
import {
  assessSecurity,
  authorizeExternalSend
} from "../security/security.js";
import { measureTokens } from "../token/tokenizer.js";
import { OptionalCopilotSdkAdapter } from "../adapters/copilot-sdk.js";
import type {
  BenchmarkCaseContract,
  BenchmarkCaseId,
  BenchmarkExportCase,
  BenchmarkModelBlock,
  BenchmarkReplayManifest,
  BenchmarkRunState,
  BenchmarkTrialPlan,
  BenchmarkTrialRecord
} from "./contracts.js";
import {
  loadBenchmarkSuite,
  loadCaseContract,
  loadRunState,
  prepareRunDirectory,
  registerBenchmarkRun,
  saveRunState
} from "./storage.js";
import {
  directoryIsEmpty,
  readBoundBytes,
  relativeToBenchmarkRoot,
  resolveInside,
  writeNewBytes
} from "./io.js";

const permissions: PermissionEnvelope = {
  sourceRead: true,
  evidenceRead: true,
  fileWrite: false,
  shell: false,
  network: true
};

function adapterMetadata(): ProducerMetadata {
  return new OptionalCopilotSdkAdapter(
    async () => {
      throw new Error("metadata-only");
    }
  ).metadata;
}

export const benchmarkSdkMetadata = adapterMetadata();
const require = createRequire(import.meta.url);

export function benchmarkSdkRuntimeIdentity(): Result<{
  readonly executableDigest: string;
  readonly protocolDigest: string;
}> {
  try {
    const cjsEntry = require.resolve("@github/copilot-sdk");
    let packageRoot = dirname(cjsEntry);
    while (true) {
      const candidatePackage = resolve(
        packageRoot,
        "package.json"
      );
      if (existsSync(candidatePackage)) {
        const candidate = JSON.parse(
          readFileSync(candidatePackage, "utf8")
        ) as { name?: string };
        if (candidate.name === "@github/copilot-sdk") break;
      }
      const parent = dirname(packageRoot);
      if (parent === packageRoot) {
        throw new Error("SDK package root not found");
      }
      packageRoot = parent;
    }
    const packagePath = resolve(
      packageRoot,
      "package.json"
    );
    const packageBytes = readFileSync(packagePath);
    const packageJson = JSON.parse(
      packageBytes.toString("utf8")
    ) as {
      exports?: {
        "."?: {
          import?: { default?: string };
        };
      };
    };
    const esmRelative =
      packageJson.exports?.["."]?.import?.default;
    if (esmRelative === undefined) {
      throw new Error("SDK ESM entry is unavailable");
    }
    const esmEntry = resolve(packageRoot, esmRelative);
    const protocolPath = resolve(
      packageRoot,
      "dist",
      "sdkProtocolVersion.js"
    );
    const cliVersionPath = resolve(
      packageRoot,
      "dist",
      "cliVersion.js"
    );
    const cliVersionBytes = readFileSync(cliVersionPath);
    const useCliNpmPackage =
      /COPILOT_CLI_USE_NPM_PACKAGE\s*=\s*true/.test(
        cliVersionBytes.toString("utf8")
      );
    const platform =
      process.platform === "linux"
        ? `linux-${process.arch}`
        : `${process.platform}-${process.arch}`;
    const explicitRuntime = process.env.COPILOT_CLI_PATH;
    let wrapperPath: string;
    let runtimeNodePath: string;
    if (explicitRuntime !== undefined) {
      wrapperPath = resolve(explicitRuntime);
      const adjacent = resolve(
        dirname(wrapperPath),
        "runtime.node"
      );
      runtimeNodePath = existsSync(adjacent)
        ? adjacent
        : resolve(
            dirname(wrapperPath),
            "prebuilds",
            platform,
            "runtime.node"
          );
    } else {
      const runtimePackage = useCliNpmPackage
        ? `@github/copilot-${platform}`
        : `@github/copilot-sdk-${platform}`;
      const searchPaths =
        require.resolve.paths(runtimePackage) ?? [];
      const runtimeRoot = searchPaths
        .map((base) =>
          resolve(
            base,
            ...runtimePackage.split("/")
          )
        )
        .find((candidate) =>
          existsSync(resolve(candidate, "package.json"))
        );
      if (runtimeRoot === undefined) {
        throw new Error("SDK runtime package is unavailable");
      }
      const prebuild = resolve(
        runtimeRoot,
        "prebuilds",
        platform
      );
      wrapperPath = resolve(
        prebuild,
        process.platform === "win32"
          ? "copilot-runtime.exe"
          : "copilot-runtime"
      );
      runtimeNodePath = resolve(prebuild, "runtime.node");
    }
    const cjsEntryBytes = readFileSync(cjsEntry);
    const esmEntryBytes = readFileSync(esmEntry);
    const protocolBytes = readFileSync(protocolPath);
    const wrapperBytes = readFileSync(wrapperPath);
    const runtimeNodeBytes = readFileSync(runtimeNodePath);
    return success({
      executableDigest: canonicalJsonDigest({
        packageSha256: sha256Base64Url(packageBytes),
        cjsEntrySha256: sha256Base64Url(cjsEntryBytes),
        esmEntrySha256: sha256Base64Url(esmEntryBytes),
        wrapperSha256: sha256Base64Url(wrapperBytes),
        runtimeNodeSha256: sha256Base64Url(runtimeNodeBytes),
        cliVersionSha256: sha256Base64Url(cliVersionBytes),
        overrideActive: explicitRuntime !== undefined,
        adapterDigest: benchmarkSdkMetadata.digest
      }),
      protocolDigest: canonicalJsonDigest({
        sdkProtocolSha256:
          sha256Base64Url(protocolBytes),
        benchmarkProtocol: {
          version: 1,
          exactApplicationPayload: true
        }
      })
    });
  } catch {
    return failure(
      "IO_ERROR",
      "Installed Copilot SDK runtime identity is unavailable"
    );
  }
}

function terminalRecord(
  plan: BenchmarkTrialPlan,
  input: Omit<BenchmarkTrialRecord, "trialId" | "digest">
): BenchmarkTrialRecord {
  const unsigned = { trialId: plan.trialId, ...input };
  return {
    ...unsigned,
    digest: canonicalJsonDigest(unsigned)
  };
}

function planSeed(suiteDigest: string): number {
  const bytes = Buffer.from(suiteDigest.slice(0, 8), "base64url");
  return bytes.readUInt32BE(0);
}

function stableRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function parseCaseSelection(
  available: readonly BenchmarkCaseId[],
  selected?: readonly string[]
): Result<readonly BenchmarkCaseId[]> {
  if (selected === undefined || selected.length === 0) {
    return success([...available]);
  }
  const unique = [...new Set(selected)] as BenchmarkCaseId[];
  const missing = unique.filter(
    (item) => !available.includes(item)
  );
  return missing.length === 0
    ? success(unique)
    : failure(
        "INVALID_ARGUMENT",
        `Case(s) are not in the exported suite: ${missing.join(", ")}`
      );
}

function modelBlocks(models: readonly string[]): Result<readonly BenchmarkModelBlock[]> {
  const runtime = benchmarkSdkRuntimeIdentity();
  if (!runtime.ok) return runtime;
  const unique = [...new Set(models.map((model) => model.trim()))].filter(
    Boolean
  );
  if (
    unique.length === 0 ||
    unique.some((model) => model.length > 200)
  ) {
    return failure(
      "INVALID_ARGUMENT",
      "At least one valid model ID is required"
    );
  }
  return success(
    unique.map((modelId) => {
      return {
        modelId,
        contextTier: "default" as const,
        reasoningEffort: null,
        settingsDigest: benchmarkApplicationSettingsDigest(
          modelId,
          permissions
        ),
        permissionDigest: canonicalJsonDigest(permissions),
        adapterId: benchmarkSdkMetadata.producerId,
        executableDigest: runtime.value.executableDigest,
        protocolDigest: runtime.value.protocolDigest
      };
    })
  );
}

export function benchmarkApplicationSettingsDigest(
  modelId: string,
  approvedPermissions: PermissionEnvelope
): string {
  return canonicalJsonDigest({
    modelId,
    contextTier: "default",
    reasoningEffort: null,
    permissions: approvedPermissions,
    availableTools: [
      ...(approvedPermissions.evidenceRead
        ? ["evidence_read"]
        : []),
      ...(approvedPermissions.sourceRead
        ? ["source_read"]
        : [])
    ]
  });
}

function createPlans(input: {
  readonly suiteCases: readonly BenchmarkExportCase[];
  readonly selectedCases: readonly BenchmarkCaseId[];
  readonly models: readonly BenchmarkModelBlock[];
  readonly helperModelId?: string;
  readonly trials: number;
  readonly seed: number;
}): readonly BenchmarkTrialPlan[] {
  const blocks: BenchmarkTrialPlan[][] = [];
  const selectedSuiteCases = input.suiteCases.filter((candidate) =>
    input.selectedCases.includes(candidate.caseId)
  );
  for (const [caseOrdinal, item] of selectedSuiteCases.entries()) {
    if (item.kind === "helper") {
      for (let trial = 1; trial <= input.trials; trial += 1) {
        const modelId = input.helperModelId ?? "not-configured";
        const helperPermissions = {
          ...permissions,
          sourceRead: false,
          evidenceRead: false
        };
        const settingsDigest =
          benchmarkApplicationSettingsDigest(
            modelId,
            helperPermissions
          );
        blocks.push([
          {
            trialId: randomUUID(),
            caseId: item.caseId,
            modelId,
            trialNumber: trial,
            arm: "helper",
            ...(input.helperModelId === undefined
              ? {}
              : {
                  payloadPath: item.prepared.path,
                  payloadSha256: item.prepared.sha256
                }),
            deterministicAbstention: false,
            helper: true,
            settingsDigest,
            permissionDigest:
              canonicalJsonDigest(helperPermissions),
            pairDigest: canonicalJsonDigest({
              caseId: item.caseId,
              trial,
              modelId,
              helper: true
            })
          }
        ]);
      }
      continue;
    }
    for (const [modelOrdinal, model] of input.models.entries()) {
      for (let trial = 1; trial <= input.trials; trial += 1) {
        let arms: readonly ("original" | "prepared" | "task")[] =
          item.kind === "model-fit"
            ? (["task"] as const)
            : (["original", "prepared"] as const);
        if (
          arms.length === 2 &&
          (input.seed + caseOrdinal + modelOrdinal + trial) %
            2 ===
            1
        ) {
          arms = ["prepared", "original"];
        }
        blocks.push(
          arms.map((arm) => {
            const identity =
              arm === "original" || arm === "task"
                ? item.original
                : item.prepared;
            return {
              trialId: randomUUID(),
              caseId: item.caseId,
              modelId: model.modelId,
              trialNumber: trial,
              arm,
              payloadPath: identity.path,
              payloadSha256: identity.sha256,
              deterministicAbstention:
                item.kind === "deterministic-abstention",
              helper: false,
              settingsDigest: model.settingsDigest,
              permissionDigest: model.permissionDigest,
              pairDigest: canonicalJsonDigest({
                caseId: item.caseId,
                trial,
                modelId: model.modelId,
                settingsDigest: model.settingsDigest,
                permissionDigest: model.permissionDigest
              })
            };
          })
        );
      }
    }
  }
  const next = stableRandom(input.seed);
  for (let index = blocks.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    [blocks[index], blocks[swap]] = [
      blocks[swap] as BenchmarkTrialPlan[],
      blocks[index] as BenchmarkTrialPlan[]
    ];
  }
  return blocks.flat();
}

function createManifest(input: {
  readonly suiteId: string;
  readonly suiteDigest: string;
  readonly sourceRootDigest: string;
  readonly selectedCases: readonly BenchmarkCaseId[];
  readonly suiteCases: readonly BenchmarkExportCase[];
  readonly models: readonly BenchmarkModelBlock[];
  readonly helperModelId?: string;
  readonly trials: number;
  readonly modelTimeoutMs: number;
  readonly catalogTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly now?: string;
}): BenchmarkReplayManifest {
  const seed = planSeed(input.suiteDigest);
  const plans = createPlans({
    suiteCases: input.suiteCases,
    selectedCases: input.selectedCases,
    models: input.models,
    ...(input.helperModelId === undefined
      ? {}
      : { helperModelId: input.helperModelId }),
    trials: input.trials,
    seed
  });
  const unsigned = {
    formatVersion: 1 as const,
    benchmarkRunId: randomUUID(),
    suiteId: input.suiteId,
    suiteDigest: input.suiteDigest,
    sourceRootDigest: input.sourceRootDigest,
    seed,
    trials: input.trials,
    modelTimeoutMs: input.modelTimeoutMs,
    catalogTimeoutMs: input.catalogTimeoutMs,
    cleanupTimeoutMs: input.cleanupTimeoutMs,
    liveOptIn: true,
    selectedCases: input.selectedCases,
    modelBlocks: input.models,
    ...(input.helperModelId === undefined
      ? {}
      : { helperModelId: input.helperModelId }),
    plans,
    estimatedCallCount: plans.filter(
      (plan) =>
        !plan.deterministicAbstention &&
        (!plan.helper || input.helperModelId !== undefined)
    ).length,
    createdAt: input.now ?? new Date().toISOString()
  };
  return {
    ...unsigned,
    digest: canonicalJsonDigest(unsigned)
  };
}

class BenchmarkSuiteAuthority implements AgentRunScopeAuthority {
  readonly #manifestDigest: string;
  readonly #payloadSha256: string;
  readonly #modelId: string;
  readonly #permissions: PermissionEnvelope;
  readonly #tokens = new Map<string, string>();

  constructor(
    manifestDigest: string,
    payloadSha256: string,
    modelId: string,
    approvedPermissions: PermissionEnvelope
  ) {
    this.#manifestDigest = manifestDigest;
    this.#payloadSha256 = payloadSha256;
    this.#modelId = modelId;
    this.#permissions = approvedPermissions;
  }

  issueReview(input: {
    readonly runId: string;
    readonly approved: Omit<ApprovedReviewPayload, "authorityToken">;
    readonly readScope: ApprovedAgentSendRequest["readScope"];
  }): Result<string> {
    const scope = agentReadScopeDigest(input.readScope);
    const approval = validateApproval({
      subject: input.approved.subject,
      approval: input.approved.approval,
      payload: input.approved.bytes
    });
    if (
      !scope.ok ||
      !approval.ok ||
      input.readScope.evidence.length !== 0 ||
      input.readScope.sources.length !== 0 ||
      sha256Base64Url(input.approved.bytes) !==
        this.#payloadSha256 ||
      input.approved.subject.policyDigest !==
        this.#manifestDigest ||
      input.approved.subject.target.modelId !== this.#modelId ||
      input.approved.subject.target.sessionId !== undefined ||
      input.approved.subject.target.contextTier !== "default" ||
      input.approved.subject.target.reasoningEffort !== undefined ||
      canonicalJsonDigest(
        input.approved.subject.target.permissions
      ) !== canonicalJsonDigest(this.#permissions) ||
      input.approved.subject.readScopeDigest !== scope.value
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Benchmark approval does not match the replay manifest"
      );
    }
    const token = `benchmark:v1:${randomUUID()}`;
    this.#tokens.set(
      token,
      canonicalJsonDigest({
        runId: input.runId,
        subject: input.approved.subject,
        approval: input.approved.approval,
        payloadSha256: this.#payloadSha256,
        readScopeDigest: scope.value
      })
    );
    return success(token);
  }

  validate(request: ApprovedAgentSendRequest): Result<void> {
    const scope = agentReadScopeDigest(request.readScope);
    if (!scope.ok) return scope;
    const expected = canonicalJsonDigest({
      runId: request.runId,
      subject: request.approved.subject,
      approval: request.approved.approval,
      payloadSha256: sha256Base64Url(request.approved.bytes),
      readScopeDigest: scope.value
    });
    return this.#tokens.get(request.approved.authorityToken) === expected
      ? success(undefined)
      : failure(
          "INTEGRITY_ERROR",
          "Benchmark authority token is invalid"
        );
  }
}

export interface BenchmarkAgentAdapter {
  readonly metadata: ProducerMetadata;
  readonly executableDigest: string;
  readonly protocolDigest: string;
  listModels(
    workingDirectory?: string
  ): Promise<Result<readonly import("../contracts/agent.js").ModelCatalogEntry[]>>;
  send(
    request: ApprovedAgentSendRequest
  ): Promise<Result<AgentSendReceipt>>;
  close(): Promise<Result<void>>;
}

export type BenchmarkAgentFactory = (
  authority: AgentRunScopeAuthority
) => BenchmarkAgentAdapter;

const defaultAgentFactory: BenchmarkAgentFactory = (authority) =>
  (() => {
    const identity = benchmarkSdkRuntimeIdentity();
    if (!identity.ok) {
      throw new Error(identity.error.message);
    }
    const adapter = new OptionalCopilotSdkAdapter(
      undefined,
      authority
    );
    return {
      metadata: adapter.metadata,
      executableDigest: identity.value.executableDigest,
      protocolDigest: identity.value.protocolDigest,
      listModels: (workingDirectory?: string) =>
        adapter.listModels(workingDirectory),
      send: (request: ApprovedAgentSendRequest) =>
        adapter.send(request),
      close: () => adapter.close()
    };
  })();

async function closeAgent(
  adapter: BenchmarkAgentAdapter,
  timeoutMs = 6_000
): Promise<Result<void>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      adapter.close(),
      new Promise<Result<void>>((resolveTimeout) => {
        timer = setTimeout(
          () =>
            resolveTimeout(
              failure(
                "IO_ERROR",
                "Benchmark agent cleanup timed out",
                { reason: "cleanup-timeout" }
              )
            ),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function boundedResult<T>(
  operation: Promise<Result<T>>,
  timeoutMs: number,
  message: string
): Promise<Result<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation.catch((error) =>
        failure("IO_ERROR", message, {
          errorDigest: canonicalJsonDigest(
            error instanceof Error ? error.message : String(error)
          )
        })
      ),
      new Promise<Result<T>>((resolveTimeout) => {
        timer = setTimeout(
          () =>
            resolveTimeout(
              failure("IO_ERROR", message, {
                reason: "timeout"
              })
            ),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function responseFacts(
  contract: BenchmarkCaseContract,
  response: string
) {
  const lower = response.toLowerCase();
  const visible = contract.requiredFacts
    .filter((item) =>
      lower.includes(item.value.toLowerCase())
    )
    .map((item) => item.factId);
  return {
    visible,
    failures: contract.requiredFacts
      .filter(
        (item) =>
          item.kind === "failure" &&
          visible.includes(item.factId)
      )
      .map((item) => item.factId),
    citations: contract.requiredFacts
      .filter(
        (item) =>
          item.kind === "citation" &&
          visible.includes(item.factId)
      )
      .map((item) => item.factId)
  };
}

function unsupportedNumberClaims(
  response: string,
  payload: Buffer
): number {
  const source = payload.toString("utf8");
  return [
    ...new Set(response.match(/\b\d{2,}\b/g) ?? [])
  ].filter((value) => !source.includes(value)).length;
}

function recoverableFacts(
  contract: BenchmarkCaseContract,
  payload: Buffer
): string[] {
  const text = payload.toString("utf8").toLowerCase();
  return contract.requiredFacts
    .filter((fact) =>
      text.includes(fact.value.toLowerCase())
    )
    .map((fact) => fact.factId);
}

function contradictionCount(
  contract: BenchmarkCaseContract,
  response: string
): number {
  const text = response.toLowerCase();
  return contract.requiredFacts.filter((fact) => {
    const value = fact.value.toLowerCase();
    return (
      text.includes(`not ${value}`) ||
      text.includes(`instead of ${value}`) ||
      text.includes(`contradicts ${value}`)
    );
  }).length;
}

function deterministicAbstention(
  plan: BenchmarkTrialPlan,
  item: BenchmarkExportCase,
  contract: BenchmarkCaseContract,
  payload: Buffer
): BenchmarkTrialRecord {
  const now = new Date().toISOString();
  return terminalRecord(plan, {
    status: "completed",
    startedAt: now,
    completedAt: now,
    sent: false,
    abstained: true,
    observation: {
      taskSuccess: true,
      visibleFactIds: [],
      recoverableFactIds: recoverableFacts(contract, payload),
      distinctFailureIds: [],
      citations: [],
      unsupportedClaims: 0,
      contradictions: 0,
      abstained: true,
      retrievalTokens: null,
      retrievalCalls: 0,
      retrievalLatencyMs: null,
      preparationLatencyMs: item.preparationLatencyMs,
      reviewLatencyMs: 0,
      handoffLatencyMs: null,
      modelLatencyMs: 0,
      inputTokens: null,
      outputTokens: null,
      decisions: 1,
      tools: 0,
      permissions: 0
    }
  });
}

function notApplicableHelper(
  plan: BenchmarkTrialPlan
): BenchmarkTrialRecord {
  const now = new Date().toISOString();
  return terminalRecord(plan, {
    status: "not-applicable",
    startedAt: now,
    completedAt: now,
    sent: false,
    abstained: true,
    errorCode: "HELPER_NOT_CONFIGURED",
    errorDigest: canonicalJsonDigest("helper-not-configured")
  });
}

function validateExistingResponse(
  outputRoot: string,
  record: BenchmarkTrialRecord
): Result<void> {
  if (
    record.status !== "completed" ||
    record.responsePath === undefined
  ) {
    return success(undefined);
  }
  const resolved = resolveInside(outputRoot, record.responsePath);
  if (!resolved.ok) return resolved;
  try {
    const bytes = readFileSync(resolved.value);
    return bytes.length === record.responseByteLength &&
      sha256Base64Url(bytes) === record.responseSha256
      ? success(undefined)
      : failure(
          "INTEGRITY_ERROR",
          "Stored benchmark response changed after execution"
        );
  } catch {
    return failure(
      "INTEGRITY_ERROR",
      "Stored benchmark response is missing"
    );
  }
}

function stateWithoutDigest(
  state: BenchmarkRunState
): Omit<BenchmarkRunState, "digest"> {
  const { digest: _digest, ...unsigned } = state;
  return unsigned;
}

export async function runBenchmarkLive(input: {
  readonly suitePath: string;
  readonly output: string;
  readonly models: readonly string[];
  readonly trials: number;
  readonly cases?: readonly string[];
  readonly helperModelId?: string;
  readonly dryRun: boolean;
  readonly liveFlag: boolean;
  readonly environmentLiveOptIn: boolean;
  readonly approvedManifestDigest?: string;
  readonly now?: string;
  readonly agentFactory?: BenchmarkAgentFactory;
  readonly modelTimeoutMs?: number;
  readonly catalogTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
}): Promise<
  Result<{
    readonly state: BenchmarkRunState;
    readonly outputRoot: string;
  }>
> {
  if (
    !Number.isSafeInteger(input.trials) ||
    input.trials <= 0 ||
    input.trials > 20
  ) {
    return failure(
      "INVALID_ARGUMENT",
      "Benchmark trials must be an integer from 1 through 20"
    );
  }
  const modelTimeoutMs = input.modelTimeoutMs ?? 120_000;
  const catalogTimeoutMs = input.catalogTimeoutMs ?? 30_000;
  const cleanupTimeoutMs = input.cleanupTimeoutMs ?? 6_000;
  if (
    ![modelTimeoutMs, catalogTimeoutMs, cleanupTimeoutMs].every(
      (value) =>
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= 10 * 60_000
    )
  ) {
    return failure(
      "INVALID_ARGUMENT",
      "Benchmark timeouts must be positive bounded integers"
    );
  }
  const suite = loadBenchmarkSuite(input.suitePath);
  if (!suite.ok) return suite;
  const output = prepareRunDirectory(input.output);
  if (!output.ok) return output;
  const selected = parseCaseSelection(
    suite.value.suite.selectedCases,
    input.cases
  );
  if (!selected.ok) return selected;
  const blocks = modelBlocks(input.models);
  if (!blocks.ok) return blocks;
  const loadedState = loadRunState(output.value);
  if (!loadedState.ok) return loadedState;
  let current: BenchmarkRunState;
  if (loadedState.value === undefined) {
    if (!directoryIsEmpty(output.value)) {
      return failure(
        "INVALID_ARGUMENT",
        "New benchmark output must be empty"
      );
    }
    const manifest = createManifest({
      suiteId: suite.value.suite.suiteId,
      suiteDigest: suite.value.suite.digest,
      sourceRootDigest: suite.value.suite.sourceRootDigest,
      selectedCases: selected.value,
      suiteCases: suite.value.suite.cases,
      models: blocks.value,
      ...(input.helperModelId === undefined
        ? {}
        : { helperModelId: input.helperModelId }),
      trials: input.trials,
      modelTimeoutMs,
      catalogTimeoutMs,
      cleanupTimeoutMs,
      ...(input.now === undefined ? {} : { now: input.now })
    });
    const created = saveRunState(output.value, {
      formatVersion: 1,
      benchmarkRunId: manifest.benchmarkRunId,
      suitePath: relativeToBenchmarkRoot(suite.value.root),
      manifest,
      status: "planned",
      trials: {},
      updatedAt: input.now ?? new Date().toISOString()
    });
    if (!created.ok) return created;
    const registered = registerBenchmarkRun(
      output.value,
      manifest.benchmarkRunId
    );
    if (!registered.ok) return registered;
    current = created.value;
  } else {
    current = loadedState.value;
  }
  if (
    current.manifest.suiteDigest !== suite.value.suite.digest ||
    canonicalJson(current.manifest.selectedCases) !==
      canonicalJson(selected.value) ||
    current.manifest.trials !== input.trials ||
    current.manifest.modelTimeoutMs !== modelTimeoutMs ||
    current.manifest.catalogTimeoutMs !== catalogTimeoutMs ||
    current.manifest.cleanupTimeoutMs !== cleanupTimeoutMs ||
    canonicalJson(current.manifest.modelBlocks) !==
      canonicalJson(blocks.value) ||
    current.manifest.helperModelId !== input.helperModelId
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Existing benchmark run does not match requested settings"
    );
  }
  const mutableTrials: Record<string, BenchmarkTrialRecord> = {
    ...current.trials
  };
  for (const [trialId, record] of Object.entries(mutableTrials)) {
    if (record.status === "running") {
      mutableTrials[trialId] = terminalRecord(
        current.manifest.plans.find(
          (plan) => plan.trialId === trialId
        ) as BenchmarkTrialPlan,
        {
          ...record,
          status: "interrupted",
          completedAt: new Date().toISOString(),
          sent: record.sent,
          errorCode: "INTERRUPTED_WITHOUT_RETRY",
          errorDigest: canonicalJsonDigest(
            "interrupted-without-retry"
          )
        }
      );
    }
    const valid = validateExistingResponse(
      output.value,
      mutableTrials[trialId] as BenchmarkTrialRecord
    );
    if (!valid.ok) return valid;
  }
  let saved = saveRunState(output.value, {
    ...stateWithoutDigest(current),
    trials: mutableTrials,
    updatedAt: new Date().toISOString()
  });
  if (!saved.ok) return saved;
  if (input.dryRun) {
    return success({ state: saved.value, outputRoot: output.value });
  }
  if (!input.liveFlag || !input.environmentLiveOptIn) {
    return failure(
      "INVALID_ARGUMENT",
      "Live benchmark requires --live and CTXO_LIVE_EVALUATION=1",
      { manifestDigest: current.manifest.digest }
    );
  }
  if (input.approvedManifestDigest !== current.manifest.digest) {
    return failure(
      "INVALID_ARGUMENT",
      "Benchmark replay manifest approval is required",
      {
        manifestDigest: current.manifest.digest,
        estimatedCallCount: current.manifest.estimatedCallCount
      }
    );
  }
  const approvedState = saveRunState(output.value, {
    ...stateWithoutDigest(saved.value),
    manifestApprovalDigest: canonicalJsonDigest({
      manifestDigest: current.manifest.digest,
      approved: true
    }),
    status: "running",
    updatedAt: new Date().toISOString()
  });
  if (!approvedState.ok) return approvedState;
  saved = approvedState;
  const factory = input.agentFactory ?? defaultAgentFactory;

  for (const plan of current.manifest.plans) {
    if (saved.value.trials[plan.trialId] !== undefined) continue;
    const item = suite.value.suite.cases.find(
      (candidate) => candidate.caseId === plan.caseId
    );
    if (item === undefined) {
      return failure(
        "INTEGRITY_ERROR",
        "Benchmark plan references an unknown exported case"
      );
    }
    const contract = loadCaseContract(suite.value.root, item);
    if (!contract.ok) return contract;
    if (plan.deterministicAbstention) {
      const identity =
        plan.arm === "original" ? item.original : item.prepared;
      const abstentionPayload = readBoundBytes(
        suite.value.root,
        identity
      );
      if (!abstentionPayload.ok) return abstentionPayload;
      mutableTrials[plan.trialId] = deterministicAbstention(
        plan,
        item,
        contract.value,
        abstentionPayload.value
      );
      const update = saveRunState(output.value, {
        ...stateWithoutDigest(saved.value),
        trials: { ...mutableTrials },
        status: "running",
        updatedAt: new Date().toISOString()
      });
      if (!update.ok) return update;
      saved = update;
      continue;
    }
    if (plan.helper && input.helperModelId === undefined) {
      mutableTrials[plan.trialId] =
        notApplicableHelper(plan);
      const update = saveRunState(output.value, {
        ...stateWithoutDigest(saved.value),
        trials: { ...mutableTrials },
        status: "running",
        updatedAt: new Date().toISOString()
      });
      if (!update.ok) return update;
      saved = update;
      continue;
    }
    const identity =
      plan.payloadPath === item.original.path
        ? item.original
        : plan.payloadPath === item.prepared.path
          ? item.prepared
          : undefined;
    if (
      identity === undefined ||
      identity.sha256 !== plan.payloadSha256
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Benchmark plan payload binding is invalid"
      );
    }
    const payload = readBoundBytes(suite.value.root, identity);
    if (!payload.ok) return payload;
    const assessment = assessSecurity([
      {
        sourceId: `benchmark:${plan.trialId}`,
        bytes: payload.value,
        trustClass: "external-untrusted"
      }
    ]);
    if (assessment.findings.some((finding) => finding.blocking)) {
      mutableTrials[plan.trialId] = terminalRecord(plan, {
        status: "blocked",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        sent: false,
        abstained: false,
        securityAssessmentDigest: assessment.digest,
        errorCode: "SECURITY_BLOCKED",
        errorDigest: canonicalJsonDigest(
          assessment.findings.map((finding) => ({
            kind: finding.kind,
            startByte: finding.startByte,
            endByte: finding.endByte
          }))
        )
      });
      const update = saveRunState(output.value, {
        ...stateWithoutDigest(saved.value),
        trials: { ...mutableTrials },
        status: "running",
        updatedAt: new Date().toISOString()
      });
      if (!update.ok) return update;
      saved = update;
      continue;
    }
    const readScope = {
      runId: plan.trialId,
      evidence: [],
      sources: []
    };
    const readScopeDigest = agentReadScopeDigest(readScope);
    if (!readScopeDigest.ok) return readScopeDigest;
    const role: ApprovalPayloadRole =
      plan.arm === "original" ? "captured" : "prepared";
    const decision: ApprovalDecision =
      plan.arm === "original"
        ? "keep-original"
        : "approve-prepared";
    const trialPermissions = plan.helper
      ? {
          ...permissions,
          sourceRead: false,
          evidenceRead: false
        }
      : permissions;
    const reviewStartedAt = performance.now();
    const subject = reviewSubjectProvider.provide({
      runId: plan.trialId,
      payload: payload.value,
      sourceIdentities: [
        {
          sourceId: `benchmark:${plan.caseId}:${plan.arm}`,
          identity: {
            sha256: identity.sha256,
            byteLength: identity.byteLength
          }
        }
      ],
      policyDigest: current.manifest.digest,
      detectorRegistryDigest: contract.value.digest,
      reviewProducerRegistry: {
        digest: builtinRuntime.reviewRegistryDigest,
        producers: builtinRuntime.reviewProducers
      },
      readScopeDigest: readScopeDigest.value,
      evidenceDecision: "ready",
      tokenizer: "o200k_base",
      target: {
        adapterId: benchmarkSdkMetadata.producerId,
        modelId: plan.modelId,
        contextTier: "default",
        workingDirectory: output.value,
        permissions: trialPermissions
      },
      snapshotChoice: "captured",
      payloadRole: role
    });
    if (!subject.ok) return subject;
    const approval = approveReviewSubject({
      subject: subject.value,
      payload: payload.value,
      decision
    });
    if (!approval.ok) return approval;
    const authority = new BenchmarkSuiteAuthority(
      current.manifest.digest,
      identity.sha256,
      plan.modelId,
      trialPermissions
    );
    const authorityToken = authority.issueReview({
      runId: plan.trialId,
      approved: {
        bytes: payload.value,
        subject: subject.value,
        approval: approval.value,
        evidenceFacts: []
      },
      readScope
    });
    if (!authorityToken.ok) return authorityToken;
    const authorization = authorizeExternalSend({
      payload: payload.value,
      assessment,
      explicitApproval: true,
      assessedSource: {
        sourceId: `benchmark:${plan.trialId}`,
        bytes: payload.value,
        trustClass: "external-untrusted"
      }
    });
    if (!authorization.ok) return authorization;
    const running = terminalRecord(plan, {
      status: "running",
      startedAt: new Date().toISOString(),
      sent: true,
      abstained: false,
      securityAssessmentDigest: assessment.digest
    });
    mutableTrials[plan.trialId] = running;
    const runningState = saveRunState(output.value, {
      ...stateWithoutDigest(saved.value),
      trials: { ...mutableTrials },
      status: "running",
      updatedAt: new Date().toISOString()
    });
    if (!runningState.ok) return runningState;
    saved = runningState;
    const adapter = factory(authority);
    const runtimeIdentity = benchmarkSdkRuntimeIdentity();
    if (!runtimeIdentity.ok) {
      await closeAgent(
        adapter,
        current.manifest.cleanupTimeoutMs
      );
      return runtimeIdentity;
    }
    const modelBlock = current.manifest.modelBlocks.find(
      (block) => block.modelId === plan.modelId
    );
    const expectedExecutableDigest =
      plan.helper
        ? runtimeIdentity.value.executableDigest
        : modelBlock?.executableDigest;
    const expectedProtocolDigest =
      plan.helper
        ? runtimeIdentity.value.protocolDigest
        : modelBlock?.protocolDigest;
    if (
      adapter.executableDigest !==
        expectedExecutableDigest ||
      adapter.protocolDigest !==
        expectedProtocolDigest
    ) {
      await closeAgent(
        adapter,
        current.manifest.cleanupTimeoutMs
      );
      return failure(
        "INTEGRITY_ERROR",
        "Benchmark adapter identity does not match the replay manifest"
      );
    }
    const catalog = await boundedResult(
      adapter.listModels(output.value),
      current.manifest.catalogTimeoutMs,
      "Benchmark model catalog request failed"
    );
    const catalogModel = catalog.ok
      ? catalog.value.find((model) => model.id === plan.modelId)
      : undefined;
    if (
      !catalog.ok ||
      catalogModel === undefined ||
      catalogModel.capabilities.policyState !== "enabled"
    ) {
      mutableTrials[plan.trialId] = terminalRecord(plan, {
        status: "failed",
        startedAt: running.startedAt ?? new Date().toISOString(),
        completedAt: new Date().toISOString(),
        sent: false,
        abstained: false,
        securityAssessmentDigest: assessment.digest,
        errorCode: "MODEL_UNAVAILABLE",
        errorDigest: canonicalJsonDigest({
          modelId: plan.modelId,
          catalogAvailable: catalog.ok
        })
      });
      await closeAgent(
        adapter,
        current.manifest.cleanupTimeoutMs
      );
      const update = saveRunState(output.value, {
        ...stateWithoutDigest(saved.value),
        trials: { ...mutableTrials },
        status: "running",
        updatedAt: new Date().toISOString()
      });
      if (!update.ok) return update;
      saved = update;
      continue;
    }
    const modelStartedAt = performance.now();
    let sent: Result<AgentSendReceipt>;
    try {
      sent = await boundedResult(
        adapter.send({
          runId: plan.trialId,
          approved: {
            bytes: payload.value,
            subject: subject.value,
            approval: approval.value,
            evidenceFacts: [],
            authorityToken: authorityToken.value
          },
          readScope,
          security: {
            assessment,
            authorization: authorization.value,
            assessedSource: {
              sourceId: `benchmark:${plan.trialId}`,
              bytes: payload.value,
              trustClass: "external-untrusted"
            }
          },
          timeoutMs: current.manifest.modelTimeoutMs
        }),
        current.manifest.modelTimeoutMs +
          current.manifest.cleanupTimeoutMs,
        "Benchmark model request timed out"
      );
    } catch (error) {
      sent = failure("IO_ERROR", "Benchmark agent threw", {
        errorDigest: canonicalJsonDigest(
          error instanceof Error ? error.message : String(error)
        )
      });
    }
    const modelLatencyMs = Math.max(
      0,
      performance.now() - modelStartedAt
    );
    if (!sent.ok) {
      const timeout =
        sent.error.details?.reason === "timeout";
      mutableTrials[plan.trialId] = terminalRecord(plan, {
        status: timeout ? "timeout" : "failed",
        startedAt: running.startedAt ?? new Date().toISOString(),
        completedAt: new Date().toISOString(),
        sent: true,
        abstained: false,
        securityAssessmentDigest: assessment.digest,
        errorCode: sent.error.code,
        errorDigest: canonicalJsonDigest({
          code: sent.error.code,
          message: sent.error.message
        })
      });
      const update = saveRunState(output.value, {
        ...stateWithoutDigest(saved.value),
        trials: { ...mutableTrials },
        status: "running",
        updatedAt: new Date().toISOString()
      });
      if (!update.ok) return update;
      saved = update;
      await closeAgent(
        adapter,
        current.manifest.cleanupTimeoutMs
      );
      continue;
    } else {
      const closed = await closeAgent(
        adapter,
        current.manifest.cleanupTimeoutMs
      );
      if (!closed.ok) {
        mutableTrials[plan.trialId] = terminalRecord(plan, {
          status: "failed",
          startedAt:
            running.startedAt ?? new Date().toISOString(),
          completedAt: new Date().toISOString(),
          sent: true,
          abstained: false,
          securityAssessmentDigest: assessment.digest,
          errorCode: closed.error.code,
          errorDigest: canonicalJsonDigest({
            code: closed.error.code,
            details: closed.error.details ?? null
          })
        });
        const update = saveRunState(output.value, {
          ...stateWithoutDigest(saved.value),
          trials: { ...mutableTrials },
          status: "running",
          updatedAt: new Date().toISOString()
        });
        if (!update.ok) return update;
        saved = update;
        continue;
      }
      const duplicateSession = Object.values(mutableTrials).some(
        (record) =>
          record.execution?.sessionId === sent.value.sessionId
      );
      if (
        sent.value.modelId !== plan.modelId ||
        sent.value.applicationPayloadSha256 !==
          identity.sha256 ||
        sent.value.applicationSettingsDigest !==
          plan.settingsDigest ||
        canonicalJsonDigest(sent.value.permissions) !==
          plan.permissionDigest ||
        canonicalJsonDigest(sent.value.producer) !==
          canonicalJsonDigest(benchmarkSdkMetadata) ||
        duplicateSession
      ) {
        mutableTrials[plan.trialId] = terminalRecord(plan, {
          status: "failed",
          startedAt:
            running.startedAt ?? new Date().toISOString(),
          completedAt: new Date().toISOString(),
          sent: true,
          abstained: false,
          securityAssessmentDigest: assessment.digest,
          errorCode: "EXECUTION_RECEIPT_MISMATCH",
          errorDigest: canonicalJsonDigest({
            actualModelId: sent.value.modelId ?? null,
            actualPayloadSha256:
              sent.value.applicationPayloadSha256,
            producer: sent.value.producer,
            duplicateSession
          })
        });
        const update = saveRunState(output.value, {
          ...stateWithoutDigest(saved.value),
          trials: { ...mutableTrials },
          status: "running",
          updatedAt: new Date().toISOString()
        });
        if (!update.ok) return update;
        saved = update;
        continue;
      }
      const response = sent.value.responseText ?? "";
      const responseSecurity = assessSecurity([
        {
          sourceId: `benchmark-response:${plan.trialId}`,
          bytes: Buffer.from(response, "utf8"),
          trustClass: "external-untrusted"
        }
      ]);
      if (
        responseSecurity.findings.some(
          (finding) => finding.blocking
        )
      ) {
        mutableTrials[plan.trialId] = terminalRecord(plan, {
          status: "blocked",
          startedAt: running.startedAt ?? new Date().toISOString(),
          completedAt: new Date().toISOString(),
          sent: true,
          abstained: false,
          securityAssessmentDigest: responseSecurity.digest,
          errorCode: "RESPONSE_SECURITY_BLOCKED",
          errorDigest: canonicalJsonDigest(
            responseSecurity.findings.map((finding) => ({
              kind: finding.kind,
              startByte: finding.startByte,
              endByte: finding.endByte
            }))
          )
        });
      } else {
        const responseBytes = Buffer.from(response, "utf8");
        const responsePath = `responses/${plan.trialId}.txt`;
        const stored = writeNewBytes(
          output.value,
          responsePath,
          responseBytes
        );
        if (!stored.ok) return stored;
        const found = responseFacts(contract.value, response);
        const abstained =
          /\b(?:insufficient|missing|cannot determine|can't determine|need more evidence|abstain)\b/i.test(
            response
          );
        const required = contract.value.requiredFacts.filter(
          (item) => item.required
        );
        const visibleRecall =
          required.length === 0
            ? 1
            : found.visible.length / required.length;
        const tokens = measureTokens(
          payload.value.toString("utf8"),
          response
        );
        mutableTrials[plan.trialId] = terminalRecord(plan, {
          status: "completed",
          startedAt: running.startedAt ?? new Date().toISOString(),
          completedAt: new Date().toISOString(),
          sent: true,
          abstained,
          responsePath: stored.value.path,
          responseSha256: stored.value.sha256,
          responseByteLength: stored.value.byteLength,
          securityAssessmentDigest: responseSecurity.digest,
          execution: {
            adapterProducerId: sent.value.producer.producerId,
            adapterProducerDigest: sent.value.producer.digest,
            executableDigest: adapter.executableDigest,
            protocolDigest: adapter.protocolDigest,
            actualModelId: sent.value.modelId ?? plan.modelId,
            actualSettingsDigest: plan.settingsDigest,
            sessionId: sent.value.sessionId,
            newSession: true,
            payloadSha256:
              sent.value.applicationPayloadSha256,
            eventCount: sent.value.events.length,
            modelLatencyMs,
            inputTokens:
              sent.value.providerUsage?.inputTokens ?? null,
            outputTokens:
              sent.value.providerUsage?.outputTokens ?? null,
            localInputTokens: tokens.ok
              ? tokens.value.originalTokens
              : 0,
            localOutputTokens: tokens.ok
              ? tokens.value.preparedTokens
              : 0,
            toolOutcomes: sent.value.events.filter((event) =>
              event.type.includes("tool")
            ).length,
            permissionOutcomes: sent.value.events.filter(
              (event) => event.type.includes("permission")
            ).length
          },
          observation: {
            taskSuccess:
              !abstained &&
              (required.length === 0 || visibleRecall >= 0.5),
            visibleFactIds: found.visible,
            recoverableFactIds: recoverableFacts(
              contract.value,
              payload.value
            ),
            distinctFailureIds: found.failures,
            citations: found.citations,
            unsupportedClaims: unsupportedNumberClaims(
              response,
              payload.value
            ),
            contradictions: contradictionCount(
              contract.value,
              response
            ),
            abstained,
            retrievalTokens: null,
            retrievalCalls: sent.value.events.filter((event) =>
              event.type.includes("tool")
            ).length,
            retrievalLatencyMs: null,
            preparationLatencyMs: item.preparationLatencyMs,
            reviewLatencyMs: Math.max(
              0,
              modelStartedAt - reviewStartedAt
            ),
            handoffLatencyMs: null,
            modelLatencyMs,
            inputTokens:
              sent.value.providerUsage?.inputTokens ?? null,
            outputTokens:
              sent.value.providerUsage?.outputTokens ?? null,
            decisions: 1,
            tools: sent.value.events.filter((event) =>
              event.type.includes("tool")
            ).length,
            permissions: sent.value.events.filter((event) =>
              event.type.includes("permission")
            ).length
          }
        });
      }
    }
    const update = saveRunState(output.value, {
      ...stateWithoutDigest(saved.value),
      trials: { ...mutableTrials },
      status: "running",
      updatedAt: new Date().toISOString()
    });
    if (!update.ok) return update;
    saved = update;
  }
  const hasFailures = Object.values(mutableTrials).some((record) =>
    ["failed", "timeout", "interrupted", "blocked"].includes(
      record.status
    )
  );
  const completed = saveRunState(output.value, {
    ...stateWithoutDigest(saved.value),
    trials: { ...mutableTrials },
    status: hasFailures
      ? "completed-with-failures"
      : "completed",
    updatedAt: new Date().toISOString()
  });
  return completed.ok
    ? success({ state: completed.value, outputRoot: output.value })
    : completed;
}
