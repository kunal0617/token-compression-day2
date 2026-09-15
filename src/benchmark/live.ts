import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync
} from "node:fs";
import {
  dirname,
  extname,
  relative,
  resolve,
  sep
} from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

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
  BenchmarkCleanupStatus,
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
const runtimeIdentityCache = new Map<
  string,
  {
    executableDigest: string;
    protocolDigest: string;
  }
>();

function implementationTreeDigest(input: {
  readonly root: string;
  readonly include: (path: string) => boolean;
}) {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = resolve(directory, name);
      const stats = statSync(path);
      if (stats.isDirectory()) visit(path);
      else if (stats.isFile() && input.include(path)) {
        files.push(path);
      }

    }
  };
  visit(input.root);
  return canonicalJsonDigest(
    files
      .sort((left, right) =>
        Buffer.compare(
          Buffer.from(relative(input.root, left), "utf8"),
          Buffer.from(relative(input.root, right), "utf8")
        )
      )
      .map((path) => ({
        path: relative(input.root, path).replaceAll("\\", "/"),
        sha256: sha256Base64Url(readFileSync(path)),
        byteLength: statSync(path).size
      }))
  );
}

function resolvePackageRootByName(
  packageName: string,
  requiringPackageRoot: string
): string | undefined {
  const scopedRequire = createRequire(
    resolve(requiringPackageRoot, "package.json")
  );
  try {
    const entry = scopedRequire.resolve(packageName);
    let root = dirname(entry);
    while (true) {
      const packagePath = resolve(root, "package.json");
      if (existsSync(packagePath)) {
        const metadata = JSON.parse(
          readFileSync(packagePath, "utf8")
        ) as { name?: string };
        if (metadata.name === packageName) {
          return realpathSync(root);
        }
      }
      const parent = dirname(root);
      if (parent === root) break;
      root = parent;
    }
  } catch {
    // Packages without a main/export entry still have a package root.
  }
  return (scopedRequire.resolve.paths(packageName) ?? [])
    .map((base) =>
      resolve(base, ...packageName.split("/"))
    )
    .find((candidate) =>
      existsSync(resolve(candidate, "package.json"))
    );
}

function packageTreeDigest(root: string): string {
  return implementationTreeDigest({
    root,
    include: (path) =>
      !relative(root, path)
        .split(sep)
        .includes("node_modules")
  });
}

export interface BenchmarkImplementationArtifact {
  readonly id: string;
  readonly path: string;
}

function defaultBenchmarkImplementationArtifacts(): readonly BenchmarkImplementationArtifact[] {
  const runnerPath = fileURLToPath(import.meta.url);
  const extension = extname(runnerPath);
  return [
    {
      id: "benchmark-runner",
      path: runnerPath
    },
    {
      id: "copilot-sdk-adapter",
      path: resolve(
        dirname(runnerPath),
        "..",
        "adapters",
        `copilot-sdk${extension}`
      )
    }
  ];
}

export function benchmarkApplicationImplementationDigest(
  artifacts: readonly BenchmarkImplementationArtifact[] =
    defaultBenchmarkImplementationArtifacts()
): string {
  return canonicalJsonDigest(
    artifacts
      .map((artifact) => {
        const bytes = readFileSync(artifact.path);
        return {
          id: artifact.id,
          sha256: sha256Base64Url(bytes),
          byteLength: bytes.length
        };
      })
      .sort((left, right) =>
        Buffer.compare(
          Buffer.from(left.id, "utf8"),
          Buffer.from(right.id, "utf8")
        )
      )
  );
}

export function benchmarkDependencyClosureDigest(
  rootPackageName: string,
  rootPackagePath: string
): string {
  const visited = new Set<string>();
  const packages: {
    name: string;
    rootDigest: string;
    treeDigest: string;
  }[] = [];
  const visit = (
    packageName: string,
    packageRoot: string
  ): void => {
    const canonicalRoot = realpathSync(packageRoot);
    if (visited.has(canonicalRoot)) return;
    visited.add(canonicalRoot);
    const packageJson = JSON.parse(
      readFileSync(
        resolve(packageRoot, "package.json"),
        "utf8"
      )
    ) as {
      dependencies?: Readonly<Record<string, string>>;
      optionalDependencies?: Readonly<Record<string, string>>;
    };
    packages.push({
      name: packageName,
      rootDigest: canonicalJsonDigest(canonicalRoot),
      treeDigest: packageTreeDigest(canonicalRoot)
    });
    const dependencies = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.optionalDependencies ?? {})
    ].sort((left, right) =>
      Buffer.compare(
        Buffer.from(left, "utf8"),
        Buffer.from(right, "utf8")
      )
    );
    for (const dependency of dependencies) {
      const dependencyRoot =
        resolvePackageRootByName(
          dependency,
          canonicalRoot
        );
      if (dependencyRoot !== undefined) {
        visit(dependency, dependencyRoot);
      }
    }
  };
  visit(rootPackageName, rootPackagePath);
  return canonicalJsonDigest(
    packages.sort(
      (left, right) =>
        Buffer.compare(
          Buffer.from(left.name, "utf8"),
          Buffer.from(right.name, "utf8")
        ) ||
        Buffer.compare(
          Buffer.from(left.rootDigest, "utf8"),
          Buffer.from(right.rootDigest, "utf8")
        )
    )
  );
}

export function benchmarkSdkImplementationTreeDigest(
  root: string
): string {
  return implementationTreeDigest({
    root,
    include: (path) =>
      path.endsWith(".js") ||
      path.endsWith("package.json")
  });
}

export function benchmarkSdkRuntimeIdentity(
  options: {
    readonly force?: boolean;
    readonly applicationArtifacts?: readonly BenchmarkImplementationArtifact[];
  } = {}
): Result<{
  readonly executableDigest: string;
  readonly protocolDigest: string;
}> {
  try {
    const applicationImplementationDigest =
      benchmarkApplicationImplementationDigest(
        options.applicationArtifacts
      );
    const cacheKey =
      `${process.env.COPILOT_CLI_PATH ?? "bundled"}:${applicationImplementationDigest}`;
    const cached = runtimeIdentityCache.get(cacheKey);
    if (cached !== undefined && options.force !== true) {
      return success(cached);
    }
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
    const explicitRuntime = process.env.COPILOT_CLI_PATH;
    const platform = benchmarkCopilotPlatform(
      explicitRuntime === undefined
        ? {}
        : { entrypoint: explicitRuntime }
    );
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
      const runtimeRoot = resolvePackageRootByName(
        runtimePackage,
        packageRoot
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
    const sdkImplementationDigest =
      benchmarkDependencyClosureDigest(
        "@github/copilot-sdk",
        packageRoot
      );
    const runtimePackageRoot =
      explicitRuntime === undefined
        ? dirname(dirname(dirname(runtimeNodePath)))
        : dirname(wrapperPath);
    const runtimeImplementationDigest =
      packageTreeDigest(runtimePackageRoot);
    const identity = {
      executableDigest: canonicalJsonDigest({
        packageSha256: sha256Base64Url(packageBytes),
        cjsEntrySha256: sha256Base64Url(cjsEntryBytes),
        esmEntrySha256: sha256Base64Url(esmEntryBytes),
        wrapperSha256: sha256Base64Url(wrapperBytes),
        runtimeNodeSha256: sha256Base64Url(runtimeNodeBytes),
        sdkImplementationDigest,
        runtimeImplementationDigest,
        applicationImplementationDigest,
        overridePathDigest:
          explicitRuntime === undefined
            ? null
            : canonicalJsonDigest(resolve(explicitRuntime)),
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
    };
    runtimeIdentityCache.set(cacheKey, identity);
    return success(identity);
  } catch {
    return failure(
      "IO_ERROR",
      "Installed Copilot SDK runtime identity is unavailable"
    );
  }
}

export function benchmarkCopilotPlatform(
  options: {
    readonly platform?: NodeJS.Platform;
    readonly arch?: string;
    readonly entrypoint?: string;
    readonly glibcVersionRuntime?: string;
  } = {}
): string {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "linux") return `${platform}-${arch}`;
  const entrypoint = options.entrypoint ?? "";
  if (entrypoint.includes(`copilot-linuxmusl-${arch}`)) {
    return `linuxmusl-${arch}`;
  }
  if (entrypoint.includes(`copilot-linux-${arch}`)) {
    return `linux-${arch}`;
  }
  let glibcVersionRuntime = options.glibcVersionRuntime;
  if (
    glibcVersionRuntime === undefined &&
    options.platform === undefined
  ) {
    const report = process.report?.getReport();
    const header =
      report !== undefined &&
      typeof report === "object" &&
      report !== null &&
      "header" in report
        ? report.header
        : undefined;
    if (
      header !== undefined &&
      typeof header === "object" &&
      header !== null &&
      "glibcVersionRuntime" in header &&
      typeof header.glibcVersionRuntime === "string"
    ) {
      glibcVersionRuntime = header.glibcVersionRuntime;
    }
  }
  return glibcVersionRuntime === undefined
    ? `linuxmusl-${arch}`
    : `linux-${arch}`;
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

function helperBlock(
  modelId: string | undefined
): Result<BenchmarkModelBlock | undefined> {
  if (modelId === undefined) return success(undefined);
  const runtime = benchmarkSdkRuntimeIdentity();
  if (!runtime.ok) return runtime;
  const helperPermissions = {
    ...permissions,
    sourceRead: false,
    evidenceRead: false
  };
  return success({
    modelId,
    contextTier: "default",
    reasoningEffort: null,
    settingsDigest: benchmarkApplicationSettingsDigest(
      modelId,
      helperPermissions
    ),
    permissionDigest: canonicalJsonDigest(helperPermissions),
    adapterId: benchmarkSdkMetadata.producerId,
    executableDigest: runtime.value.executableDigest,
    protocolDigest: runtime.value.protocolDigest
  });
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
  readonly helperBlock?: BenchmarkModelBlock;
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
        const modelId =
          input.helperBlock?.modelId ?? "not-configured";
        const helperPermissions = {
          ...permissions,
          sourceRead: false,
          evidenceRead: false
        };
        const settingsDigest =
          input.helperBlock?.settingsDigest ??
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
              input.helperBlock?.permissionDigest ??
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
  readonly helperBlock?: BenchmarkModelBlock;
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
    ...(input.helperBlock === undefined
      ? {}
      : { helperBlock: input.helperBlock }),
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
    ...(input.helperBlock === undefined
      ? {}
      : { helperBlock: input.helperBlock }),
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
  forceClose?(): Promise<Result<void>>;
}

export type BenchmarkAgentFactory = (
  authority: AgentRunScopeAuthority,
  hooks?: {
    readonly onTimeout?: (details: {
      readonly runId: string;
      readonly sessionId: string;
    }) => Promise<void> | void;
    readonly catalogTimeoutMs?: number;
    readonly cleanupTimeoutMs?: number;
  },
  runtimeIdentity?: {
    readonly executableDigest: string;
    readonly protocolDigest: string;
  }
) => BenchmarkAgentAdapter;

const defaultAgentFactory: BenchmarkAgentFactory = (
  authority,
  hooks,
  runtimeIdentity
) =>
  (() => {
    if (runtimeIdentity === undefined) {
      throw new Error(
        "Benchmark runtime identity is required"
      );
    }
    const adapter = new OptionalCopilotSdkAdapter(
      undefined,
      authority,
      {
        ...(hooks?.catalogTimeoutMs === undefined
          ? {}
          : { catalogTimeoutMs: hooks.catalogTimeoutMs }),
        ...(hooks?.cleanupTimeoutMs === undefined
          ? {}
          : { cleanupTimeoutMs: hooks.cleanupTimeoutMs }),
        ...(hooks?.onTimeout === undefined
          ? {}
          : { onTimeout: hooks.onTimeout })
      }
    );
    return {
      metadata: adapter.metadata,
      executableDigest: runtimeIdentity.executableDigest,
      protocolDigest: runtimeIdentity.protocolDigest,
      listModels: (workingDirectory?: string) =>
        adapter.listModels(workingDirectory),
      send: (request: ApprovedAgentSendRequest) =>
        adapter.send(request),
      close: () => adapter.close(),
      forceClose: () => adapter.forceClose()
    };
  })();

interface BenchmarkCleanupOutcome {
  readonly status: "completed" | "timed-out" | "failed";
  readonly latencyMs: number;
  readonly warningCode?: string;
  readonly warningDigest?: string;
}

async function boundedAgentForceClose(
  adapter: BenchmarkAgentAdapter,
  timeoutMs: number
): Promise<boolean> {
  if (adapter.forceClose === undefined) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      adapter.forceClose().then(
        (result) => result.ok,
        () => false
      ),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(
          () => resolveTimeout(false),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closeAgent(
  adapter: BenchmarkAgentAdapter,
  timeoutMs = 6_000
): Promise<BenchmarkCleanupOutcome> {
  const startedAt = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const closed = await Promise.race([
      adapter.close().then((result) => ({
        kind: "result" as const,
        result
      })),
      new Promise<{ readonly kind: "timed-out" }>((resolveTimeout) => {
        timer = setTimeout(
          () => resolveTimeout({ kind: "timed-out" }),
          timeoutMs
        );
      })
    ]);
    if (closed.kind === "result" && closed.result.ok) {
      return {
        status: "completed",
        latencyMs: Math.max(0, performance.now() - startedAt)
      };
    }
    let reason = "cleanup-timeout";
    let warningCode = "IO_ERROR";
    let cleanupConfirmed = false;
    if (closed.kind === "result" && !closed.result.ok) {
      const error = closed.result.error;
      reason =
        typeof error.details?.reason === "string"
          ? error.details.reason
          : "cleanup-failed";
      warningCode = error.code;
      cleanupConfirmed =
        error.details?.cleanupConfirmed === true;
    }
    if (!cleanupConfirmed && adapter.forceClose !== undefined) {
      cleanupConfirmed = await boundedAgentForceClose(
        adapter,
        timeoutMs
      );
    }
    return {
      status: reason.includes("timeout")
        ? "timed-out"
        : "failed",
      latencyMs: Math.max(0, performance.now() - startedAt),
      warningCode,
      warningDigest: canonicalJsonDigest({
        warningCode,
        reason,
        cleanupConfirmed
      })
    };
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
  const visible = contract.requiredFacts
    .filter((item) => factPresent(response, item))
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

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literalPresent(text: string, value: string): boolean {
  return literalOccurrences(text, value).length > 0;
}

function literalOccurrences(
  text: string,
  value: string
): readonly { readonly start: number; readonly end: number }[] {
  const normalized = value.trim();
  if (normalized.length === 0) return [];
  if (/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    const leftBoundary = /^[A-Za-z0-9_]/.test(normalized)
      ? "(?<![A-Za-z0-9_])"
      : "";
    const rightBoundary = /[A-Za-z0-9_]$/.test(normalized)
      ? "(?![A-Za-z0-9_])"
      : "";
    return [...text.matchAll(new RegExp(
      `${leftBoundary}${escaped(
        normalized
      )}${rightBoundary}`,
      "gi"
    ))].flatMap((match) =>
      match.index === undefined
        ? []
        : [
            {
              start: match.index,
              end: match.index + match[0].length
            }
          ]
    );
  }
  const loweredText = text.toLowerCase();
  const loweredValue = normalized.toLowerCase();
  const occurrences: { start: number; end: number }[] = [];
  let start = loweredText.indexOf(loweredValue);
  while (start >= 0) {
    occurrences.push({
      start,
      end: start + loweredValue.length
    });
    start = loweredText.indexOf(loweredValue, start + 1);
  }
  return occurrences;
}

function roleAssignments(text: string): {
  role: "expected" | "actual";
  clause: string;
}[] {
  const assignments: {
    role: "expected" | "actual";
    clause: string;
  }[] = [];
  const pattern =
    /\b(expected|actual|received)\b\s*(?::|=|\bis\b)?\s*([\s\S]*?)(?=\b(?:expected|actual|received)\b|[\r\n]|$)/gi;
  for (const match of text.matchAll(pattern)) {
    const label = match[1]?.toLowerCase();
    const clause = match[2]
      ?.replace(/\b(?:but|and|while)\s*$/i, "")
      .trim();
    if (label === undefined || clause === undefined) continue;
    assignments.push({
      role: label === "expected" ? "expected" : "actual",
      clause
    });
  }
  return assignments;
}

function rolePresent(
  text: string,
  role: "expected" | "actual",
  value: string
): boolean {
  return roleAssignments(text).some(
    (assignment) =>
      assignment.role === role &&
      literalOccurrences(assignment.clause, value).some(
        (occurrence) =>
          !roleOccurrenceRejected(
            assignment.clause,
            occurrence
          )
      )
  );
}

function roleOccurrenceRejected(
  clause: string,
  occurrence: { readonly start: number; readonly end: number }
): boolean {
  const prefix = clause.slice(
    Math.max(0, occurrence.start - 96),
    occurrence.start
  );
  const suffix = clause.slice(
    occurrence.end,
    Math.min(clause.length, occurrence.end + 64)
  );
  return (
    /(?:\bnot(?:\s+(?:equal\s+to|the\s+value))?|\bnever|\bwithout|\binstead\s+of|\brather\s+than|\bas\s+opposed\s+to|\breject(?:ed|ing)?|\bexclude(?:d|ing)?|\banything\s+but)\s*[\s"'([{,:=-]*$/i.test(
      prefix
    ) ||
    /^\s*(?:[,;:=-]\s*)?(?:(?:is|was|would\s+be|should\s+be)\s+)?(?:not\s+(?:expected|correct|accepted)|incorrect|wrong|rejected|excluded)\b/i.test(
      suffix
    )
  );
}

function roleRejected(
  text: string,
  role: "expected" | "actual",
  value: string
): boolean {
  return roleAssignments(text).some(
    (assignment) =>
      assignment.role === role &&
      literalOccurrences(assignment.clause, value).some(
        (occurrence) =>
          roleOccurrenceRejected(
            assignment.clause,
            occurrence
          )
      )
  );
}

function factPresent(
  text: string,
  fact: BenchmarkCaseContract["requiredFacts"][number]
): boolean {
  if (fact.kind === "expected") {
    return rolePresent(text, "expected", fact.value);
  }
  if (fact.kind === "actual") {
    return rolePresent(text, "actual", fact.value);
  }
  return literalPresent(text, fact.value);
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
    .filter((fact) => factPresent(text, fact))
    .map((fact) => fact.factId);
}

function contradictionCount(
  contract: BenchmarkCaseContract,
  response: string
): number {
  const explicit = contract.requiredFacts.filter((fact) => {
    const factRole =
      fact.kind === "expected"
        ? "expected"
        : fact.kind === "actual"
          ? "actual"
          : undefined;
    if (factRole !== undefined) {
      return roleRejected(response, factRole, fact.value);
    }
    return new RegExp(
      `\\bcontradicts\\s+${escaped(fact.value)}(?:\\b|$)`,
      "i"
    ).test(response);
  }).length;
  const expected = contract.requiredFacts.filter(
    (fact) => fact.kind === "expected"
  );
  const actual = contract.requiredFacts.filter(
    (fact) => fact.kind === "actual"
  );
  const inversions = expected.filter((expectedFact) => {
    const key = expectedFact.label.replace(/^expected:/, "");
    const actualFact = actual.find(
      (candidate) =>
        candidate.label.replace(/^actual:/, "") === key
    );
    return (
      actualFact !== undefined &&
      rolePresent(response, "actual", expectedFact.value) &&
      rolePresent(response, "expected", actualFact.value)
    );
  }).length;
  return explicit + inversions;
}

export function assessBenchmarkResponse(
  contract: BenchmarkCaseContract,
  response: string,
  payload: Buffer
) {
  const found = responseFacts(contract, response);
  return {
    visibleFactIds: found.visible,
    recoverableFactIds: recoverableFacts(contract, payload),
    distinctFailureIds: found.failures,
    citations: found.citations,
    contradictions: contradictionCount(contract, response)
  };
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
    cleanupStatus: "not-required",
    cleanupLatencyMs: 0,
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
    cleanupStatus: "not-required",
    cleanupLatencyMs: 0,
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

function withCleanup(
  plan: BenchmarkTrialPlan,
  record: BenchmarkTrialRecord,
  cleanup: {
    readonly status: BenchmarkCleanupStatus;
    readonly latencyMs: number;
    readonly warningCode?: string;
    readonly warningDigest?: string;
  }
): BenchmarkTrialRecord {
  const {
    trialId: _trialId,
    digest: _digest,
    cleanupStatus: _cleanupStatus,
    cleanupLatencyMs: _cleanupLatencyMs,
    cleanupWarningCode: _cleanupWarningCode,
    cleanupWarningDigest: _cleanupWarningDigest,
    ...unsigned
  } = record;
  return terminalRecord(plan, {
    ...unsigned,
    cleanupStatus: cleanup.status,
    cleanupLatencyMs: cleanup.latencyMs,
    ...(cleanup.warningCode === undefined
      ? {}
      : { cleanupWarningCode: cleanup.warningCode }),
    ...(cleanup.warningDigest === undefined
      ? {}
      : { cleanupWarningDigest: cleanup.warningDigest })
  });
}

async function persistTrialAndCleanup(input: {
  readonly outputRoot: string;
  readonly state: BenchmarkRunState;
  readonly trials: Record<string, BenchmarkTrialRecord>;
  readonly plan: BenchmarkTrialPlan;
  readonly record: BenchmarkTrialRecord;
  readonly adapter: BenchmarkAgentAdapter;
  readonly cleanupTimeoutMs: number;
}): Promise<Result<BenchmarkRunState>> {
  input.trials[input.plan.trialId] = withCleanup(
    input.plan,
    input.record,
    {
      status: "pending",
      latencyMs: 0
    }
  );
  const persisted = saveRunState(input.outputRoot, {
    ...stateWithoutDigest(input.state),
    trials: { ...input.trials },
    status: "running",
    updatedAt: new Date().toISOString()
  });
  if (!persisted.ok) return persisted;
  const cleanup = await closeAgent(
    input.adapter,
    input.cleanupTimeoutMs
  );
  input.trials[input.plan.trialId] = withCleanup(
    input.plan,
    input.trials[input.plan.trialId] as BenchmarkTrialRecord,
    cleanup
  );
  return saveRunState(input.outputRoot, {
    ...stateWithoutDigest(persisted.value),
    trials: { ...input.trials },
    status: "running",
    updatedAt: new Date().toISOString()
  });
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
  const helper = helperBlock(input.helperModelId);
  if (!helper.ok) return helper;
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
      ...(helper.value === undefined
        ? {}
        : { helperBlock: helper.value }),
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
    canonicalJson(current.manifest.helperBlock ?? null) !==
      canonicalJson(helper.value ?? null) ||
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
  let executionRuntime:
    | {
        readonly executableDigest: string;
        readonly protocolDigest: string;
      }
    | undefined;
  if (input.agentFactory === undefined) {
    const runtime = benchmarkSdkRuntimeIdentity({
      force: true
    });
    if (!runtime.ok) return runtime;
    executionRuntime = runtime.value;
    if (
      current.manifest.modelBlocks.some(
        (block) =>
          block.executableDigest !==
            runtime.value.executableDigest ||
          block.protocolDigest !==
            runtime.value.protocolDigest
      ) ||
      (current.manifest.helperBlock !== undefined &&
        (current.manifest.helperBlock.executableDigest !==
          runtime.value.executableDigest ||
          current.manifest.helperBlock.protocolDigest !==
            runtime.value.protocolDigest))
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Installed Copilot runtime changed after manifest approval"
      );
    }
  }

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
        cleanupStatus: "not-required",
        cleanupLatencyMs: 0,
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
    let timeoutPersisted = false;
    let timeoutPersistenceFailure:
      | Result<BenchmarkRunState>
      | undefined;
    const adapter = factory(
      authority,
      {
        catalogTimeoutMs: current.manifest.catalogTimeoutMs,
        cleanupTimeoutMs: current.manifest.cleanupTimeoutMs,
        onTimeout: async () => {
        timeoutPersisted = true;
        mutableTrials[plan.trialId] = terminalRecord(plan, {
          status: "timeout",
          startedAt:
            running.startedAt ?? new Date().toISOString(),
          completedAt: new Date().toISOString(),
          sent: true,
          abstained: false,
          securityAssessmentDigest: assessment.digest,
          errorCode: "IO_ERROR",
          errorDigest: canonicalJsonDigest({
            reason: "timeout-before-cleanup"
          })
        });
        if (!saved.ok) {
          timeoutPersistenceFailure = saved;
          return;
        }
        const persisted = saveRunState(output.value, {
          ...stateWithoutDigest(saved.value),
          trials: { ...mutableTrials },
          status: "running",
          updatedAt: new Date().toISOString()
        });
        if (persisted.ok) {
          saved = persisted;
        } else {
          timeoutPersistenceFailure = persisted;
        }
        }
      },
      executionRuntime
    );
    const modelBlock = current.manifest.modelBlocks.find(
      (block) => block.modelId === plan.modelId
    );
    const expectedExecutableDigest =
      plan.helper
        ? current.manifest.helperBlock?.executableDigest
        : modelBlock?.executableDigest;
    const expectedProtocolDigest =
      plan.helper
        ? current.manifest.helperBlock?.protocolDigest
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
      const record = terminalRecord(plan, {
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
      const update = await persistTrialAndCleanup({
        outputRoot: output.value,
        state: saved.value,
        trials: mutableTrials,
        plan,
        record,
        adapter,
        cleanupTimeoutMs: current.manifest.cleanupTimeoutMs
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
    if (
      timeoutPersistenceFailure !== undefined &&
      !timeoutPersistenceFailure.ok
    ) {
      await closeAgent(
        adapter,
        current.manifest.cleanupTimeoutMs
      );
      return timeoutPersistenceFailure;
    }
    if (!sent.ok) {
      const timeout =
        timeoutPersisted ||
        sent.error.details?.reason === "timeout";
      const record = terminalRecord(plan, {
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
      const update = await persistTrialAndCleanup({
        outputRoot: output.value,
        state: saved.value,
        trials: mutableTrials,
        plan,
        record,
        adapter,
        cleanupTimeoutMs: current.manifest.cleanupTimeoutMs
      });
      if (!update.ok) return update;
      saved = update;
      continue;
    } else {
      const duplicateSession = Object.values(mutableTrials).some(
        (record) =>
          record.execution?.sessionId === sent.value.sessionId
      );
      const response =
        typeof sent.value.responseText === "string"
          ? sent.value.responseText
          : undefined;
      const responseBytes =
        response === undefined
          ? undefined
          : Buffer.from(response, "utf8");
      const hasAssistantMessage = sent.value.events.some(
        (event) => event.type === "assistant.message"
      );
      const hasTurnEnd = sent.value.events.some(
        (event) => event.type === "assistant.turn_end"
      );
      const hasUsageEvent = sent.value.events.some((event) =>
        event.type.includes("usage")
      );
      if (
        sent.value.modelId !== plan.modelId ||
        sent.value.applicationPayloadSha256 !==
          identity.sha256 ||
        sent.value.applicationSettingsDigest !==
          plan.settingsDigest ||
        sent.value.providerUsage === undefined ||
        sent.value.providerUsage.modelIds.length === 0 ||
        sent.value.providerUsage.modelIds.some(
          (modelId) => modelId !== plan.modelId
        ) ||
        canonicalJsonDigest(sent.value.permissions) !==
          plan.permissionDigest ||
        canonicalJsonDigest(sent.value.producer) !==
          canonicalJsonDigest(benchmarkSdkMetadata) ||
        duplicateSession ||
        responseBytes === undefined ||
        responseBytes.length === 0 ||
        !hasAssistantMessage ||
        !hasTurnEnd ||
        !hasUsageEvent
      ) {
        const record = terminalRecord(plan, {
          status: "failed",
          startedAt:
            running.startedAt ?? new Date().toISOString(),
          completedAt: new Date().toISOString(),
          sent: true,
          abstained: false,
          securityAssessmentDigest: assessment.digest,
          errorCode:
            responseBytes === undefined ||
            responseBytes.length === 0 ||
            !hasAssistantMessage ||
            !hasTurnEnd ||
            !hasUsageEvent
              ? "INVALID_MODEL_RESPONSE"
              : "EXECUTION_RECEIPT_MISMATCH",
          errorDigest: canonicalJsonDigest({
            actualModelId: sent.value.modelId ?? null,
            actualPayloadSha256:
              sent.value.applicationPayloadSha256,
            producer: sent.value.producer,
            duplicateSession,
            responsePresent:
              responseBytes !== undefined &&
              responseBytes.length > 0,
            hasAssistantMessage,
            hasTurnEnd,
            hasUsageEvent
          })
        });
        const update = await persistTrialAndCleanup({
          outputRoot: output.value,
          state: saved.value,
          trials: mutableTrials,
          plan,
          record,
          adapter,
          cleanupTimeoutMs: current.manifest.cleanupTimeoutMs
        });
        if (!update.ok) return update;
        saved = update;
        continue;
      }
      const responseSecurity = assessSecurity([
        {
          sourceId: `benchmark-response:${plan.trialId}`,
          bytes: responseBytes,
          trustClass: "external-untrusted"
        }
      ]);
      if (
        responseSecurity.findings.some(
          (finding) => finding.blocking
        )
      ) {
        const record = terminalRecord(plan, {
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
        const update = await persistTrialAndCleanup({
          outputRoot: output.value,
          state: saved.value,
          trials: mutableTrials,
          plan,
          record,
          adapter,
          cleanupTimeoutMs: current.manifest.cleanupTimeoutMs
        });
        if (!update.ok) return update;
        saved = update;
      } else {
        const attestedResponse = responseBytes.toString("utf8");
        const responsePath = `responses/${plan.trialId}.txt`;
        const stored = writeNewBytes(
          output.value,
          responsePath,
          responseBytes
        );
        if (!stored.ok) {
          await closeAgent(
            adapter,
            current.manifest.cleanupTimeoutMs
          );
          return stored;
        }
        const assessedResponse = assessBenchmarkResponse(
          contract.value,
          attestedResponse,
          payload.value
        );
        const abstained =
          /\b(?:insufficient|missing|cannot determine|can't determine|need more evidence|abstain)\b/i.test(
            attestedResponse
          );
        const required = contract.value.requiredFacts.filter(
          (item) => item.required
        );
        const visibleRecall =
          required.length === 0
            ? 1
            : assessedResponse.visibleFactIds.length /
              required.length;
        const tokens = measureTokens(
          payload.value.toString("utf8"),
          attestedResponse
        );
        const record = terminalRecord(plan, {
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
            visibleFactIds:
              assessedResponse.visibleFactIds,
            recoverableFactIds:
              assessedResponse.recoverableFactIds,
            distinctFailureIds:
              assessedResponse.distinctFailureIds,
            citations: assessedResponse.citations,
            unsupportedClaims: unsupportedNumberClaims(
              attestedResponse,
              payload.value
            ),
            contradictions:
              assessedResponse.contradictions,
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
        const update = await persistTrialAndCleanup({
          outputRoot: output.value,
          state: saved.value,
          trials: mutableTrials,
          plan,
          record,
          adapter,
          cleanupTimeoutMs: current.manifest.cleanupTimeoutMs
        });
        if (!update.ok) return update;
        saved = update;
      }
      continue;
    }
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
