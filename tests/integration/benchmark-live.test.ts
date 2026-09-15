import {
  mkdtempSync,
  readFileSync,
  rmSync,
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
import type { Result } from "../../src/core/result.js";
import { success } from "../../src/core/result.js";
import { canonicalJsonDigest } from "../../src/core/canonical.js";
import { sha256Base64Url } from "../../src/core/hash.js";
import { exportBenchmarkSuite } from "../../src/benchmark/export.js";
import {
  type BenchmarkAgentAdapter,
  runBenchmarkLive
} from "../../src/benchmark/live.js";
import {
  buildBenchmarkReport,
  writeBenchmarkReport
} from "../../src/benchmark/report.js";
import { runCli } from "../../src/main.js";
import { writeManualBenchmarkFixture } from "../helpers/manual-benchmark-fixture.js";

const producer: ProducerMetadata = {
  producerId: "optional.github.copilot-sdk-adapter",
  kind: "coding-agent",
  version: "1.0.0",
  digest: canonicalJsonDigest("fake-benchmark-agent")
};

class FakeBenchmarkAgent implements BenchmarkAgentAdapter {
  readonly metadata = producer;
  readonly #authority: AgentRunScopeAuthority;
  readonly requests: ApprovedAgentSendRequest[];

  constructor(
    authority: AgentRunScopeAuthority,
    requests: ApprovedAgentSendRequest[]
  ) {
    this.#authority = authority;
    this.requests = requests;
  }

  async send(
    request: ApprovedAgentSendRequest
  ): Promise<Result<AgentSendReceipt>> {
    const valid = this.#authority.validate(request);
    if (!valid.ok) return valid;
    this.requests.push(request);
    const responseText = request.approved.bytes.toString("utf8");
    return success({
      runId: request.runId,
      sessionId: `session-${request.runId}`,
      ...(request.approved.subject.target.modelId === undefined
        ? {}
        : {
            modelId:
              request.approved.subject.target.modelId
          }),
      applicationPayloadSha256: sha256Base64Url(
        request.approved.bytes
      ),
      permissions:
        request.approved.subject.target.permissions,
      events: [
        {
          type: "assistant.message",
          timestamp: "2030-01-01T00:00:00.000Z"
        }
      ],
      responseText,
      timedOut: false,
      aborted: false,
      producer
    });
  }

  async close(): Promise<Result<void>> {
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
  });

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
      expect(report.value.report.models.map((model) => model.modelId)).toEqual(
        expect.arrayContaining([
          "claude-opus-5",
          "gpt-5.4-mini"
        ])
      );
      expect(
        writeBenchmarkReport(runId, "json").ok
      ).toBe(true);
      expect(
        writeBenchmarkReport(runId, "markdown").ok
      ).toBe(true);
      expect(
        writeBenchmarkReport(runId, "csv").ok
      ).toBe(true);

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
  });

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
        cases: ["cq03-incomplete", "cq06-missing"]
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
          "cq03-incomplete,cq06-missing",
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
          "cq03-incomplete,cq06-missing",
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
          "cq03-incomplete,cq06-missing",
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
