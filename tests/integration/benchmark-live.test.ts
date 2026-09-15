import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  AgentRunScopeAuthority,
  AgentSendReceipt,
  ApprovedAgentSendRequest
} from "../../src/contracts/agent.js";
import type { ProducerMetadata } from "../../src/contracts/providers.js";
import type { BenchmarkCaseContract } from "../../src/benchmark/contracts.js";
import type { Result } from "../../src/core/result.js";
import { success } from "../../src/core/result.js";
import { canonicalJsonDigest } from "../../src/core/canonical.js";
import { sha256Base64Url } from "../../src/core/hash.js";
import { exportBenchmarkSuite } from "../../src/benchmark/export.js";
import {
  benchmarkApplicationSettingsDigest,
  assessBenchmarkResponse,
  benchmarkSdkImplementationTreeDigest,
  benchmarkSdkMetadata,
  benchmarkSdkRuntimeIdentity,
  type BenchmarkAgentAdapter,
  runBenchmarkLive
} from "../../src/benchmark/live.js";
import {
  benchmarkPathFromRelative,
  relativeToBenchmarkRoot
} from "../../src/benchmark/io.js";
import {
  loadBenchmarkSuite,
  loadCaseContract
} from "../../src/benchmark/storage.js";
import {
  buildBenchmarkReport,
  writeBenchmarkReport
} from "../../src/benchmark/report.js";
import { runCli } from "../../src/main.js";
import { writeManualBenchmarkFixture } from "../helpers/manual-benchmark-fixture.js";

const producer: ProducerMetadata = benchmarkSdkMetadata;
function requiredRuntimeIdentity() {
  const identity = benchmarkSdkRuntimeIdentity();
  if (!identity.ok) {
    throw new Error(identity.error.message);
  }
  return identity.value;
}
const runtimeIdentity = requiredRuntimeIdentity();

class FakeBenchmarkAgent implements BenchmarkAgentAdapter {
  readonly metadata = producer;
  readonly executableDigest: string;
  readonly protocolDigest: string;
  readonly #authority: AgentRunScopeAuthority;
  readonly requests: ApprovedAgentSendRequest[];
  readonly #overrideModelId: string | undefined;
  readonly #fixedSessionId: string | undefined;
  readonly #sendPending: boolean;
  readonly #closePending: boolean;
  readonly #responseText: string | undefined;

  constructor(
    authority: AgentRunScopeAuthority,
    requests: ApprovedAgentSendRequest[],
    options: {
      readonly overrideModelId?: string;
      readonly fixedSessionId?: string;
      readonly sendPending?: boolean;
      readonly closePending?: boolean;
      readonly responseText?: string;
      readonly executableDigest?: string;
      readonly protocolDigest?: string;
    } = {}
  ) {
    this.#authority = authority;
    this.requests = requests;
    this.#overrideModelId = options.overrideModelId;
    this.#fixedSessionId = options.fixedSessionId;
    this.#sendPending = options.sendPending === true;
    this.#closePending = options.closePending === true;
    this.#responseText = options.responseText;
    this.executableDigest =
      options.executableDigest ??
      runtimeIdentity.executableDigest;
    this.protocolDigest =
      options.protocolDigest ??
      runtimeIdentity.protocolDigest;
  }

  async send(
    request: ApprovedAgentSendRequest
  ): Promise<Result<AgentSendReceipt>> {
    const valid = this.#authority.validate(request);
    if (!valid.ok) return valid;
    if (this.#sendPending) {
      return new Promise(() => undefined);
    }
    this.requests.push(request);
    const responseText =
      this.#responseText ??
      request.approved.bytes.toString("utf8");
    return success({
      runId: request.runId,
      sessionId:
        this.#fixedSessionId ?? `session-${request.runId}`,
      ...(request.approved.subject.target.modelId === undefined
        ? {}
        : {
            modelId:
              this.#overrideModelId ??
              request.approved.subject.target.modelId
          }),
      applicationPayloadSha256: sha256Base64Url(
        request.approved.bytes
      ),
      applicationSettingsDigest:
        benchmarkApplicationSettingsDigest(
          request.approved.subject.target.modelId as string,
          request.approved.subject.target.permissions
        ),
      permissions:
        request.approved.subject.target.permissions,
      events: [
        {
          type: "assistant.message",
          timestamp: "2030-01-01T00:00:00.000Z"
        }
      ],
      providerUsage: {
        inputTokens: 100,
        outputTokens: 25,
        modelIds: [
          this.#overrideModelId ??
            (request.approved.subject.target.modelId as string)
        ]
      },
      responseText,
      timedOut: false,
      aborted: false,
      producer
    });
  }

  async listModels() {
    const requested =
      this.#overrideModelId ?? "gpt-5.4-mini";
    return success([
      {
        id: "claude-opus-5",
        name: "Claude Opus 5",
        capabilities: { policyState: "enabled" }
      },
      {
        id: "gpt-5.4-mini",
        name: "GPT-5.4 mini",
        capabilities: { policyState: "enabled" }
      },
      {
        id: requested,
        name: requested,
        capabilities: { policyState: "enabled" }
      }
    ]);
  }

  async close(): Promise<Result<void>> {
    if (this.#closePending) {
      return new Promise(() => undefined);
    }
    return success(undefined);
  }
}

describe("benchmark live and reporting", () => {
  it("plans the default two-model three-trial run as exactly 102 calls", async () => {
    const externalRoot = mkdtempSync(
      join(tmpdir(), "ctxo-benchmark-full-source-")
    );
    const suiteRoot = resolve(
      ".context-overflow",
      `benchmark-full-suite-${Date.now()}`
    );
    const runRoot = resolve(
      ".context-overflow",
      `benchmark-full-run-${Date.now()}`
    );
    let runId: string | undefined;
    try {
      writeManualBenchmarkFixture(externalRoot);
      const exported = await exportBenchmarkSuite({
        externalRoot,
        output: suiteRoot
      });
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      const planned = await runBenchmarkLive({
        suitePath: suiteRoot,
        output: runRoot,
        models: ["claude-opus-5", "gpt-5.4-mini"],
        trials: 3,
        dryRun: true,
        liveFlag: false,
        environmentLiveOptIn: false
      });
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;
      runId = planned.value.state.benchmarkRunId;
      expect(
        planned.value.state.manifest.estimatedCallCount
      ).toBe(102);
      expect(
        planned.value.state.manifest.plans
          .filter((plan) => plan.caseId === "mf01")
          .every(
            (plan) =>
              plan.arm === "task" &&
              plan.payloadPath?.endsWith("/original.bin")
          )
      ).toBe(true);
      const pairs = planned.value.state.manifest.plans.filter(
        (plan) =>
          plan.caseId === "cq02" &&
          plan.modelId === "claude-opus-5"
      );
      const orderByPair = new Map<string, string[]>();
      for (const plan of pairs) {
        orderByPair.set(plan.pairDigest, [
          ...(orderByPair.get(plan.pairDigest) ?? []),
          plan.arm
        ]);
      }
      expect(
        [...orderByPair.values()].every(
          (arms) =>
            arms.length === 2 &&
            new Set(arms).size === 2
        )
      ).toBe(true);
      expect(
        new Set(
          [...orderByPair.values()].map((arms) =>
            arms.join(",")
          )
        ).size
      ).toBeGreaterThan(1);
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
      rmSync(suiteRoot, { recursive: true, force: true });
      rmSync(runRoot, { recursive: true, force: true });
      if (runId !== undefined) {
        rmSync(
          resolve(
            ".context-overflow",
            "benchmark-index",
            `${runId}.json`
          ),
          { force: true }
        );
      }
    }
  }, 30_000);

  it("plans, approves, resumes, and reports per model without duplicate sends", async () => {
    const externalRoot = mkdtempSync(
      join(tmpdir(), "ctxo-benchmark-live-source-")
    );
    const suiteRoot = resolve(
      ".context-overflow",
      `benchmark-suite-${Date.now()}`
    );
    const runRoot = resolve(
      ".context-overflow",
      `benchmark-run-${Date.now()}`
    );
    let runId: string | undefined;
    try {
      writeManualBenchmarkFixture(externalRoot);
      const exported = await exportBenchmarkSuite({
        externalRoot,
        output: suiteRoot,
        cases: [
          "cq02",
          "cq03-incomplete",
          "cq06-missing",
          "mf01"
        ]
      });
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      const requests: ApprovedAgentSendRequest[] = [];
      const agentFactory = (
        authority: AgentRunScopeAuthority
      ) => new FakeBenchmarkAgent(authority, requests);
      const common = {
        suitePath: suiteRoot,
        output: runRoot,
        models: ["claude-opus-5", "gpt-5.4-mini"],
        trials: 1,
        cases: [
          "cq02",
          "cq03-incomplete",
          "cq06-missing",
          "mf01"
        ],
        liveFlag: true,
        environmentLiveOptIn: true,
        agentFactory
      };
      const planned = await runBenchmarkLive({
        ...common,
        dryRun: true
      });
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;
      runId = planned.value.state.benchmarkRunId;
      expect(
        planned.value.state.manifest.estimatedCallCount
      ).toBe(6);
      const paired = planned.value.state.manifest.plans.filter(
        (plan) =>
          plan.caseId === "cq02" &&
          plan.modelId === "claude-opus-5"
      );
      expect(new Set(paired.map((plan) => plan.pairDigest)).size).toBe(
        1
      );
      expect(new Set(paired.map((plan) => plan.settingsDigest)).size).toBe(
        1
      );

      const missingOptIn = await runBenchmarkLive({
        ...common,
        dryRun: false,
        liveFlag: false,
        approvedManifestDigest:
          planned.value.state.manifest.digest
      });
      expect(missingOptIn.ok).toBe(false);
      expect(requests).toHaveLength(0);

      const mismatched = await runBenchmarkLive({
        ...common,
        dryRun: false,
        approvedManifestDigest: canonicalJsonDigest("wrong")
      });
      expect(mismatched.ok).toBe(false);
      expect(requests).toHaveLength(0);

      const executed = await runBenchmarkLive({
        ...common,
        dryRun: false,
        approvedManifestDigest:
          planned.value.state.manifest.digest
      });
      expect(executed.ok).toBe(true);
      if (!executed.ok) return;
      expect(requests).toHaveLength(6);
      expect(
        new Set(
          requests.map(
            (request) =>
              request.approved.subject.target.modelId
          )
        )
      ).toEqual(
        new Set(["claude-opus-5", "gpt-5.4-mini"])
      );
      expect(
        new Set(
          Object.values(executed.value.state.trials)
            .flatMap((record) =>
              record.execution === undefined
                ? []
                : [record.execution.sessionId]
            )
        ).size
      ).toBe(6);
      expect(
        Object.values(executed.value.state.trials).filter(
          (record) => !record.sent && record.abstained
        )
      ).toHaveLength(8);

      const resumed = await runBenchmarkLive({
        ...common,
        dryRun: false,
        approvedManifestDigest:
          planned.value.state.manifest.digest
      });
      expect(resumed.ok).toBe(true);
      expect(requests).toHaveLength(6);

      const report = buildBenchmarkReport(runId);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(
        report.value.report.deterministicAdvice.some(
          (item) => item.caseId === "mf01"
        )
      ).toBe(true);
      expect(report.value.report.models.map((model) => model.modelId)).toEqual(
        expect.arrayContaining([
          "claude-opus-5",
          "gpt-5.4-mini"
        ])
      );
      expect(
        report.value.report.models.every((model) =>
          model.scores
            .filter((value) => value.inputTokens !== null)
            .every(
            (value) =>
              value.inputTokens === 100 &&
              value.outputTokens === 25
            )
        )
      ).toBe(true);
      expect(
        report.value.report.models.some((model) =>
          model.scores.some(
            (value) => value.inputTokens === null
          )
        )
      ).toBe(true);
      expect(
        writeBenchmarkReport(runId, "json").ok
      ).toBe(true);
      expect(
        writeBenchmarkReport(runId, "markdown").ok
      ).toBe(true);
      expect(
        writeBenchmarkReport(runId, "csv").ok
      ).toBe(true);
      const markdown = readFileSync(
        join(runRoot, "reports", "shareable.md"),
        "utf8"
      );
      expect(
        (markdown.match(/## Deterministic model advice/g) ?? [])
      ).toHaveLength(1);
      const csv = readFileSync(
        join(runRoot, "reports", "shareable.csv"),
        "utf8"
      );
      expect(csv).toContain("terminal-status");
      expect(csv).toContain("deterministic-advice");
      writeFileSync(
        join(runRoot, "reports", "shareable.json"),
        "stale preliminary report",
        "utf8"
      );
      expect(
        writeBenchmarkReport(runId, "json").ok
      ).toBe(true);
      expect(
        readFileSync(
          join(runRoot, "reports", "shareable.json"),
          "utf8"
        )
      ).toContain(runId);

      const response = Object.values(
        executed.value.state.trials
      ).find((record) => record.responsePath !== undefined);
      expect(response?.responsePath).toBeDefined();
      if (response?.responsePath === undefined) return;
      writeFileSync(
        join(runRoot, response.responsePath),
        "mutated response",
        "utf8"
      );
      expect(buildBenchmarkReport(runId).ok).toBe(false);
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
      rmSync(suiteRoot, { recursive: true, force: true });
      rmSync(runRoot, { recursive: true, force: true });
      if (runId !== undefined) {
        rmSync(
          resolve(
            ".context-overflow",
            "benchmark-index",
            `${runId}.json`
          ),
          { force: true }
        );
      }
    }
  }, 30_000);

  it("blocks secret-bearing payloads before fake adapter send", async () => {
    const externalRoot = mkdtempSync(
      join(tmpdir(), "ctxo-benchmark-secret-source-")
    );
    const suiteRoot = resolve(
      ".context-overflow",
      `benchmark-secret-suite-${Date.now()}`
    );
    const runRoot = resolve(
      ".context-overflow",
      `benchmark-secret-run-${Date.now()}`
    );
    let runId: string | undefined;
    try {
      writeManualBenchmarkFixture(externalRoot, {
        "cq02-diagnostics/request.txt":
          `FAIL tests/a.test.ts > case\nExpected: safe\nReceived: unsafe\nsecret=ghp_${"A".repeat(
            40
          )}\nProcess exited with code 1\n`
      });

      const exported = await exportBenchmarkSuite({
        externalRoot,
        output: suiteRoot,
        cases: ["cq02"]
      });
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      const requests: ApprovedAgentSendRequest[] = [];
      const planned = await runBenchmarkLive({
        suitePath: suiteRoot,
        output: runRoot,
        models: ["gpt-5.4-mini"],
        trials: 1,
        cases: ["cq02"],
        dryRun: true,
        liveFlag: true,
        environmentLiveOptIn: true,
        agentFactory: (authority) =>
          new FakeBenchmarkAgent(authority, requests)
      });
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;
      runId = planned.value.state.benchmarkRunId;
      const executed = await runBenchmarkLive({
        suitePath: suiteRoot,
        output: runRoot,
        models: ["gpt-5.4-mini"],
        trials: 1,
        cases: ["cq02"],
        dryRun: false,
        liveFlag: true,
        environmentLiveOptIn: true,
        approvedManifestDigest:
          planned.value.state.manifest.digest,
        agentFactory: (authority) =>
          new FakeBenchmarkAgent(authority, requests)
      });
      expect(executed.ok).toBe(true);
      expect(requests).toHaveLength(0);
      expect(
        executed.ok &&
          Object.values(executed.value.state.trials).every(
            (record) => record.status === "blocked"
          )
      ).toBe(true);
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
      rmSync(suiteRoot, { recursive: true, force: true });
      rmSync(runRoot, { recursive: true, force: true });
      if (runId !== undefined) {
        rmSync(
          resolve(
            ".context-overflow",
            "benchmark-index",
            `${runId}.json`
          ),
          { force: true }
        );
      }
    }
  });

  it("fails closed on model or session receipt mismatch", async () => {
    const externalRoot = mkdtempSync(
      join(tmpdir(), "ctxo-benchmark-receipt-source-")
    );
    const suiteRoot = resolve(
      ".context-overflow",
      `benchmark-receipt-suite-${Date.now()}`
    );
    const runRoot = resolve(
      ".context-overflow",
      `benchmark-receipt-run-${Date.now()}`
    );
    let runId: string | undefined;
    try {
      writeManualBenchmarkFixture(externalRoot);
      const exported = await exportBenchmarkSuite({
        externalRoot,
        output: suiteRoot,
        cases: ["cq02"]
      });

      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      const planned = await runBenchmarkLive({
        suitePath: suiteRoot,
        output: runRoot,
        models: ["gpt-5.4-mini"],
        trials: 1,
        cases: ["cq02"],
        dryRun: true,
        liveFlag: true,
        environmentLiveOptIn: true
      });
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;
      runId = planned.value.state.benchmarkRunId;
      const executed = await runBenchmarkLive({
        suitePath: suiteRoot,
        output: runRoot,
        models: ["gpt-5.4-mini"],
        trials: 1,
        cases: ["cq02"],
        dryRun: false,
        liveFlag: true,
        environmentLiveOptIn: true,
        approvedManifestDigest:
          planned.value.state.manifest.digest,
        agentFactory: (authority) =>
          new FakeBenchmarkAgent(authority, [], {
            overrideModelId: "wrong-model",
            fixedSessionId: "shared-session"
          })
      });
      expect(executed.ok).toBe(true);
      expect(
        executed.ok &&
          Object.values(executed.value.state.trials).every(
            (record) =>
              record.status === "failed" &&
              record.errorCode ===
                "EXECUTION_RECEIPT_MISMATCH"
          )
      ).toBe(true);
      const report = buildBenchmarkReport(runId);
      expect(report.ok).toBe(true);
      if (report.ok) {
        expect(
          report.value.report.models[0]?.trialStatusCounts.failed
        ).toBe(2);
        expect(
          report.value.report.models[0]?.completePairCount
        ).toBe(0);
        expect(
          report.value.report.models[0]?.warnings.some(
            (warning) => warning.includes("failure")
          )
        ).toBe(true);
      }
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
      rmSync(suiteRoot, { recursive: true, force: true });
      rmSync(runRoot, { recursive: true, force: true });
      if (runId !== undefined) {
        rmSync(
          resolve(
            ".context-overflow",
            "benchmark-index",
            `${runId}.json`
          ),
          { force: true }
        );
      }
    }
  });

  it("computes arm means only from complete A/B pairs", async () => {
    const externalRoot = mkdtempSync(
      join(tmpdir(), "ctxo-benchmark-asymmetric-source-")
    );
    const suiteRoot = resolve(
      ".context-overflow",
      `benchmark-asymmetric-suite-${Date.now()}`
    );
    const runRoot = resolve(
      ".context-overflow",
      `benchmark-asymmetric-run-${Date.now()}`
    );
    let runId: string | undefined;
    try {
      writeManualBenchmarkFixture(externalRoot);
      const exported = await exportBenchmarkSuite({
        externalRoot,
        output: suiteRoot,
        cases: ["cq02"]
      });
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      const planned = await runBenchmarkLive({
        suitePath: suiteRoot,
        output: runRoot,
        models: ["gpt-5.4-mini"],
        trials: 1,
        cases: ["cq02"],
        dryRun: true,
        liveFlag: true,
        environmentLiveOptIn: true
      });
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;
      runId = planned.value.state.benchmarkRunId;
      let factoryCalls = 0;
      const executed = await runBenchmarkLive({
        suitePath: suiteRoot,
        output: runRoot,
        models: ["gpt-5.4-mini"],
        trials: 1,
        cases: ["cq02"],
        dryRun: false,
        liveFlag: true,
        environmentLiveOptIn: true,
        approvedManifestDigest:
          planned.value.state.manifest.digest,
        agentFactory: (authority) => {
          const index = factoryCalls;
          factoryCalls += 1;
          return new FakeBenchmarkAgent(authority, [], {
            ...(index === 0
              ? { overrideModelId: "wrong-model" }
              : {})
          });
        }
      });
      expect(executed.ok).toBe(true);
      const report = buildBenchmarkReport(runId);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(
        report.value.report.models[0]?.completePairCount
      ).toBe(0);
      expect(report.value.report.models[0]?.originalMean).toBe(0);
      expect(report.value.report.models[0]?.preparedMean).toBe(0);
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
      rmSync(suiteRoot, { recursive: true, force: true });
      rmSync(runRoot, { recursive: true, force: true });
      if (runId !== undefined) {
        rmSync(
          resolve(
            ".context-overflow",
            "benchmark-index",
            `${runId}.json`
          ),
          { force: true }
        );
      }
    }
  });

  it("rejects benchmark run junctions that resolve outside the ignored root", () => {
    const outside = mkdtempSync(
      join(tmpdir(), "ctxo-benchmark-run-outside-")
    );
    const link = resolve(
      ".context-overflow",
      `benchmark-run-link-${Date.now()}`
    );
    try {
      symlinkSync(outside, link, "junction");
      expect(
        benchmarkPathFromRelative(
          relativeToBenchmarkRoot(link)
        ).ok
      ).toBe(false);
    } finally {
      rmSync(link, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("binds the effective SDK runtime override bytes", () => {
    const runtimeRoot = mkdtempSync(
      join(tmpdir(), "ctxo-sdk-runtime-")
    );
    const wrapper = join(runtimeRoot, "copilot-runtime.exe");
    const runtimeNode = join(runtimeRoot, "runtime.node");
    const secondRoot = mkdtempSync(
      join(tmpdir(), "ctxo-sdk-runtime-copy-")
    );
    const original = process.env.COPILOT_CLI_PATH;
    try {
      writeFileSync(wrapper, "wrapper-one", "utf8");
      writeFileSync(runtimeNode, "runtime-one", "utf8");
      process.env.COPILOT_CLI_PATH = wrapper;
      const first = benchmarkSdkRuntimeIdentity();
      expect(first.ok).toBe(true);
      writeFileSync(wrapper, "wrapper-two", "utf8");
      const second = benchmarkSdkRuntimeIdentity();
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.value.executableDigest).not.toBe(
        second.value.executableDigest
      );
      writeFileSync(
        join(secondRoot, "copilot-runtime.exe"),
        "wrapper-two",
        "utf8"
      );
      writeFileSync(
        join(secondRoot, "runtime.node"),
        "runtime-one",
        "utf8"
      );
      process.env.COPILOT_CLI_PATH = join(
        secondRoot,
        "copilot-runtime.exe"
      );
      const moved = benchmarkSdkRuntimeIdentity();
      expect(moved.ok).toBe(true);
      if (moved.ok) {
        expect(moved.value.executableDigest).not.toBe(
          second.value.executableDigest
        );
      }
    } finally {
      if (original === undefined) {
        delete process.env.COPILOT_CLI_PATH;
      } else {
        process.env.COPILOT_CLI_PATH = original;
      }
      rmSync(runtimeRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it("binds both ESM and CJS SDK implementation trees", () => {
    const root = mkdtempSync(
      join(tmpdir(), "ctxo-sdk-tree-")
    );
    try {
      mkdirSync(join(root, "cjs"), { recursive: true });
      writeFileSync(join(root, "index.js"), "export {};\n");
      writeFileSync(
        join(root, "cjs", "client.js"),
        "module.exports = {};\n"
      );
      writeFileSync(
        join(root, "cjs", "package.json"),
        '{"type":"commonjs"}'
      );
      const first =
        benchmarkSdkImplementationTreeDigest(root);
      writeFileSync(
        join(root, "cjs", "client.js"),
        "module.exports = { changed: true };\n"
      );
      const second =
        benchmarkSdkImplementationTreeDigest(root);
      expect(first).not.toBe(second);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists typed timeout state before bounded cleanup", async () => {
    const externalRoot = mkdtempSync(
      join(tmpdir(), "ctxo-benchmark-timeout-source-")
    );
    const suiteRoot = resolve(
      ".context-overflow",
      `benchmark-timeout-suite-${Date.now()}`
    );
    const runRoot = resolve(
      ".context-overflow",
      `benchmark-timeout-run-${Date.now()}`
    );
    let runId: string | undefined;
    try {
      writeManualBenchmarkFixture(externalRoot);
      const exported = await exportBenchmarkSuite({
        externalRoot,
        output: suiteRoot,
        cases: ["cq02"]
      });

      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      const planned = await runBenchmarkLive({
        suitePath: suiteRoot,
        output: runRoot,
        models: ["gpt-5.4-mini"],
        trials: 1,
        cases: ["cq02"],
        dryRun: true,
        liveFlag: true,
        environmentLiveOptIn: true,
        modelTimeoutMs: 10,
        catalogTimeoutMs: 100,
        cleanupTimeoutMs: 10
      });
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;
      runId = planned.value.state.benchmarkRunId;
      const executed = await runBenchmarkLive({
        suitePath: suiteRoot,
        output: runRoot,
        models: ["gpt-5.4-mini"],
        trials: 1,
        cases: ["cq02"],
        dryRun: false,
        liveFlag: true,
        environmentLiveOptIn: true,
        approvedManifestDigest:
          planned.value.state.manifest.digest,
        modelTimeoutMs: 10,
        catalogTimeoutMs: 100,
        cleanupTimeoutMs: 10,
        agentFactory: (authority) =>
          new FakeBenchmarkAgent(authority, [], {
            sendPending: true,
            closePending: true
          })
      });
      expect(executed.ok).toBe(true);
      expect(
        executed.ok &&
          Object.values(executed.value.state.trials).every(
            (record) =>
              record.status === "timeout" &&
              record.errorCode === "IO_ERROR"
          )
      ).toBe(true);
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
      rmSync(suiteRoot, { recursive: true, force: true });
      rmSync(runRoot, { recursive: true, force: true });
      if (runId !== undefined) {
        rmSync(
          resolve(
            ".context-overflow",
            "benchmark-index",
            `${runId}.json`
          ),
          { force: true }
        );
      }
    }
  });

  it("binds configured helper execution to its approved runtime", async () => {
    const externalRoot = mkdtempSync(
      join(tmpdir(), "ctxo-benchmark-helper-source-")
    );
    const suiteRoot = resolve(
      ".context-overflow",
      `benchmark-helper-suite-${Date.now()}`
    );
    const runRoot = resolve(
      ".context-overflow",
      `benchmark-helper-run-${Date.now()}`
    );
    let runId: string | undefined;
    try {
      writeManualBenchmarkFixture(externalRoot);
      const exported = await exportBenchmarkSuite({
        externalRoot,
        output: suiteRoot,
        cases: ["luna"]
      });
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      const planned = await runBenchmarkLive({
        suitePath: suiteRoot,
        output: runRoot,
        models: ["gpt-5.4-mini"],
        helperModelId: "gpt-5.6-luna",
        trials: 1,
        cases: ["luna"],
        dryRun: true,
        liveFlag: true,
        environmentLiveOptIn: true
      });
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;
      runId = planned.value.state.benchmarkRunId;
      expect(
        planned.value.state.manifest.helperBlock?.modelId
      ).toBe("gpt-5.6-luna");
      const executed = await runBenchmarkLive({
        suitePath: suiteRoot,
        output: runRoot,
        models: ["gpt-5.4-mini"],
        helperModelId: "gpt-5.6-luna",
        trials: 1,
        cases: ["luna"],
        dryRun: false,
        liveFlag: true,
        environmentLiveOptIn: true,
        approvedManifestDigest:
          planned.value.state.manifest.digest,
        agentFactory: (authority) =>
          new FakeBenchmarkAgent(authority, [], {
            executableDigest: canonicalJsonDigest(
              "changed-helper-runtime"
            )
          })
      });
      expect(executed.ok).toBe(false);
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
      rmSync(suiteRoot, { recursive: true, force: true });
      rmSync(runRoot, { recursive: true, force: true });
      if (runId !== undefined) {
        rmSync(
          resolve(
            ".context-overflow",
            "benchmark-index",
            `${runId}.json`
          ),
          { force: true }
        );
      }
    }
  });

  it("uses role-scoped exact matching for overlapping expected and actual values", () => {
    const unsigned = {
      caseId: "cq02" as const,
      contract: "CQ-02",
      kind: "paired" as const,
      prompt: "diagnose",
      requiredFacts: [
        {
          factId: "expected-safe",
          label: "expected:case",
          value: "safe",
          valueSha256: sha256Base64Url(
            Buffer.from("safe")
          ),
          kind: "expected" as const,
          required: true
        },
        {
          factId: "actual-unsafe",
          label: "actual:case",
          value: "unsafe",
          valueSha256: sha256Base64Url(
            Buffer.from("unsafe")
          ),
          kind: "actual" as const,
          required: true
        }
      ],
      allowAbstention: false
    };
    const contract: BenchmarkCaseContract = {
      ...unsigned,
      digest: canonicalJsonDigest(unsigned)
    };
    const payload = Buffer.from(
      "Expected: safe\nReceived: unsafe\n"
    );
    const correct = assessBenchmarkResponse(
      contract,
      "Expected: safe but Received: unsafe",
      payload
    );
    expect(correct.contradictions).toBe(0);
    expect(correct.visibleFactIds).toEqual([
      "expected-safe",
      "actual-unsafe"
    ]);
    const inverted = assessBenchmarkResponse(
      contract,
      "Expected: unsafe\nReceived: safe\n",
      payload
    );
    expect(inverted.contradictions).toBe(1);
    expect(inverted.visibleFactIds).toEqual([]);
  });

  it("detects expected/actual inversion without overlapping-value false matches", async () => {
    const externalRoot = mkdtempSync(
      join(tmpdir(), "ctxo-benchmark-contradiction-source-")
    );
    const suiteRoot = resolve(
      ".context-overflow",
      `benchmark-contradiction-suite-${Date.now()}`
    );
    const runRoot = resolve(
      ".context-overflow",
      `benchmark-contradiction-run-${Date.now()}`
    );
    let runId: string | undefined;
    try {
      writeManualBenchmarkFixture(externalRoot, {
        "cq02-diagnostics/request.txt": [
          "FAIL tests/a.test.ts > suite > case",
          "Expected: safe",
          "Received: unsafe",
          "Process exited with code 1",
          ""
        ].join("\n")
      });
      const exported = await exportBenchmarkSuite({
        externalRoot,
        output: suiteRoot,
        cases: ["cq02"]
      });
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      const planned = await runBenchmarkLive({
        suitePath: suiteRoot,
        output: runRoot,
        models: ["gpt-5.4-mini"],
        trials: 1,
        cases: ["cq02"],
        dryRun: true,
        liveFlag: true,
        environmentLiveOptIn: true
      });
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;
      runId = planned.value.state.benchmarkRunId;
      const executed = await runBenchmarkLive({
        suitePath: suiteRoot,
        output: runRoot,
        models: ["gpt-5.4-mini"],
        trials: 1,
        cases: ["cq02"],
        dryRun: false,
        liveFlag: true,
        environmentLiveOptIn: true,
        approvedManifestDigest:
          planned.value.state.manifest.digest,
        agentFactory: (authority) =>
          new FakeBenchmarkAgent(authority, [], {
            responseText:
              "Expected: unsafe\nReceived: safe\n"
          })
      });
      expect(executed.ok).toBe(true);
      const report = buildBenchmarkReport(runId);
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(
        report.value.report.models[0]?.scores.every(
          (value) => value.contradictions > 0
        )
      ).toBe(true);
      expect(
        report.value.report.models[0]?.scores.every(
          (value) => value.visibleEvidenceRecall < 1
        )
      ).toBe(true);
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
      rmSync(suiteRoot, { recursive: true, force: true });
      rmSync(runRoot, { recursive: true, force: true });
      if (runId !== undefined) {
        rmSync(
          resolve(
            ".context-overflow",
            "benchmark-index",
            `${runId}.json`
          ),
          { force: true }
        );
      }
    }
  });

  it("supports a zero-call CLI dry-run, approved abstention run, and report", async () => {
    const externalRoot = mkdtempSync(
      join(tmpdir(), "ctxo-benchmark-cli-source-")
    );
    const suiteRoot = resolve(
      ".context-overflow",
      `benchmark-cli-suite-${Date.now()}`
    );
    const runRoot = resolve(
      ".context-overflow",
      `benchmark-cli-run-${Date.now()}`
    );
    let runId: string | undefined;
    const originalOptIn = process.env.CTXO_LIVE_EVALUATION;
    try {
      writeManualBenchmarkFixture(externalRoot);
      const exported = await exportBenchmarkSuite({
        externalRoot,
        output: suiteRoot,
        cases: ["cq03-incomplete", "cq06-missing", "luna"]
      });
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      const stdout: string[] = [];
      const dryRun = await runCli(
        [
          "benchmark",
          "live",
          "--suite",
          suiteRoot,
          "--models",
          "claude-opus-5,gpt-5.4-mini",
          "--trials",
          "1",
          "--cases",
          "cq03-incomplete,cq06-missing,luna",
          "--output",
          runRoot,
          "--dry-run"
        ],
        {
          stdout: (value) => stdout.push(String(value)),
          stderr: () => undefined
        }
      );
      expect(dryRun).toBe(0);
      const manifest = JSON.parse(
        stdout.join("").split("\n")[0] as string
      ) as {
        benchmarkRunId: string;
        digest: string;
        estimatedCallCount: number;
      };
      runId = manifest.benchmarkRunId;
      expect(manifest.estimatedCallCount).toBe(0);
      expect(buildBenchmarkReport(runId).ok).toBe(false);
      const outsideTemp = join(
        tmpdir(),
        `ctxo-benchmark-temp-${Date.now()}`
      );
      const staleTemp = join(
        runRoot,
        "benchmark-run.json.tmp"
      );
      const { mkdirSync } = await import("node:fs");
      mkdirSync(outsideTemp);
      writeFileSync(
        join(outsideTemp, "marker.txt"),
        "outside",
        "utf8"
      );
      symlinkSync(outsideTemp, staleTemp, "junction");

      let questioned = false;
      delete process.env.CTXO_LIVE_EVALUATION;
      const missingOptIn = await runCli(
        [
          "benchmark",
          "live",
          "--suite",
          suiteRoot,
          "--models",
          "claude-opus-5,gpt-5.4-mini",
          "--trials",
          "1",
          "--cases",
          "cq03-incomplete,cq06-missing,luna",
          "--output",
          runRoot,
          "--live"
        ],
        {
          stdout: () => undefined,
          stderr: () => undefined,
          question: async () => {
            questioned = true;
            return manifest.digest;
          }
        }
      );
      expect(missingOptIn).toBe(1);
      expect(questioned).toBe(false);

      process.env.CTXO_LIVE_EVALUATION = "1";
      const executed = await runCli(
        [
          "benchmark",
          "live",
          "--suite",
          suiteRoot,
          "--models",
          "claude-opus-5,gpt-5.4-mini",
          "--trials",
          "1",
          "--cases",
          "cq03-incomplete,cq06-missing,luna",
          "--output",
          runRoot,
          "--live",
          "--approve-manifest",
          manifest.digest
        ],
        {
          stdout: () => undefined,
          stderr: () => undefined
        }
      );
      expect(executed).toBe(0);
      expect(
        readFileSync(
          join(outsideTemp, "marker.txt"),
          "utf8"
        )
      ).toBe("outside");
      rmSync(staleTemp, { recursive: true, force: true });
      rmSync(outsideTemp, { recursive: true, force: true });

      const reportOutput: string[] = [];
      const reported = await runCli(
        [
          "benchmark",
          "report",
          "--run",
          runId,
          "--format",
          "markdown"
        ],
        {
          stdout: (value) =>
            reportOutput.push(String(value)),
          stderr: () => undefined
        }
      );
      expect(reported).toBe(0);
      expect(reportOutput.join("")).toContain(
        "# Context Overflow benchmark report"
      );
      expect(reportOutput.join("")).toContain(
        "## Optional helper"
      );
      expect(
        (
          reportOutput
            .join("")
            .match(/## Optional helper/g) ?? []
        ).length
      ).toBe(1);
      const csvReport = writeBenchmarkReport(runId, "csv");
      expect(csvReport.ok).toBe(true);
      if (csvReport.ok) {
        expect(csvReport.value.content).toContain(
          "helper-status"
        );
      }
    } finally {
      if (originalOptIn === undefined) {
        delete process.env.CTXO_LIVE_EVALUATION;
      } else {
        process.env.CTXO_LIVE_EVALUATION = originalOptIn;
      }
      rmSync(externalRoot, { recursive: true, force: true });
      rmSync(suiteRoot, { recursive: true, force: true });
      rmSync(runRoot, { recursive: true, force: true });
      if (runId !== undefined) {
        rmSync(
          resolve(
            ".context-overflow",
            "benchmark-index",
            `${runId}.json`
          ),
          { force: true }
        );
      }
    }
  });
});
