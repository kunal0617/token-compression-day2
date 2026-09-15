import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/core/canonical.js";
import {
  ExternalManualParityAdapter,
  manualParityExitCode
} from "../../src/evaluation/manual-parity.js";

const files: Readonly<Record<string, string>> = {
  "cq01-source-match/inventory-reconciler.ts":
    "export function reconcile(value: number) { return value + 1; }\n",
  "cq01-source-match/request.txt":
    "Locate this exact source:\n```ts\nexport function reconcile(value: number) { return value + 1; }\n```",
  "cq02-diagnostics/request.txt": [
    "FAIL tests/a.test.ts > suite > case",
    "Expected: 2",
    "Received: 1",
    "TypeError [ERR_TEST_FAILURE]: invented",
    "    at run (src/a.ts:2:3)",
    "Process exited with code 1",
    ""
  ].join("\n"),
  "cq03-incomplete/request.txt":
    "A failure occurred but the detailed failure block is missing.\n",
  "cq03-incomplete/complete-follow-up.txt":
    "Complete invented failure evidence with exact bounded detail.\n",
  "cq04-repetition/request.txt":
    `header\n${"repeated invented line\n".repeat(120)}footer\n`,
  "cq05-source-scope/request.txt": [
    "function helper() { return 42; }",
    "export function run() { return helper(); }",
    "export const unrelated = 7;",
    ""
  ].join("\n"),
  "cq06-missing-fact/checkout-events.jsonl":
    '{"event":"invented"}\n',
  "cq06-missing-fact/missing-response.txt":
    "Request failed without the observed contract fact.\n",
  "cq06-missing-fact/observed-response.txt":
    "Request failed. status=503 body=invented-error correlationId=cid-demo Error\n",
  "cq06-missing-fact/response-observation.json":
    '{"status":503,"body":"invented-error","correlationId":"cid-demo"}',
  "cq07-source-version/changed-config.txt":
    "Captured and current snapshots differ.\n",
  "cq07-source-version/dispatch-worker.captured.json":
    '{"enabled":false}\n',
  "cq07-source-version/dispatch-worker.current.json":
    '{"enabled":true}\n',
  "mf01-exact-operation/prompt.txt":
    "Perform an exact deterministic operation.\n",
  "mf02-routine/prompt.txt":
    "Perform a bounded routine operation.\n",
  "mf03-reasoning/prompt.txt":
    "Perform a reasoning-intensive operation.\n",
  "luna/prompt.txt":
    "SENTINEL_PRIVATE_CONTENT must never appear in the report.\n"
};

function writeFixture(root: string): void {
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }
}

describe("safe external manual parity adapter", () => {
  it("reads the known layout without emitting fixture content", async () => {
    const root = mkdtempSync(join(tmpdir(), "ctxo-manual-parity-"));
    try {
      writeFixture(root);
      const result = await new ExternalManualParityAdapter({
        root
      }).run();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.cases).toHaveLength(11);
      expect(
        result.value.cases.find(
          (item) => item.caseId === "cq01-source-match"
        )?.status
      ).toBe("pass");
      expect(
        result.value.summary.passed +
          result.value.summary.failed +
          result.value.summary.notApplicable
      ).toBe(11);
      expect(canonicalJson(result.value)).not.toContain(
        "SENTINEL_PRIVATE_CONTENT"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a fixture exceeds the read limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "ctxo-manual-limit-"));
    try {
      writeFixture(root);
      const result = await new ExternalManualParityAdapter({
        root,
        maxFileBytes: 8
      }).run();
      expect(result.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a failing command status for logical contract failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "ctxo-manual-fail-"));
    try {
      writeFixture(root);
      writeFileSync(
        join(root, "cq01-source-match", "request.txt"),
        "No exact source fence is present.",
        "utf8"
      );
      writeFileSync(
        join(root, "luna", "prompt.txt"),
        Buffer.from([0xff, 0xfe])
      );
      const result = await new ExternalManualParityAdapter({
        root
      }).run();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.summary.failed).toBeGreaterThan(0);
      expect(manualParityExitCode(result.value)).toBe(1);
      expect(
        result.value.cases.find(
          (item) => item.caseId === "luna"
        )?.status
      ).toBe("fail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
