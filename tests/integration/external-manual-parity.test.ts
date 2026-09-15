import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../src/core/canonical.js";
import {
  ExternalManualParityAdapter,
  manualParityExitCode
} from "../../src/evaluation/manual-parity.js";
import { writeManualBenchmarkFixture } from "../helpers/manual-benchmark-fixture.js";

describe("safe external manual parity adapter", () => {
  it("reads the known layout without emitting fixture content", async () => {
    const root = mkdtempSync(join(tmpdir(), "ctxo-manual-parity-"));
    try {
      writeManualBenchmarkFixture(root, {
        "luna/prompt.txt":
          "SENTINEL_PRIVATE_CONTENT must never appear in the report.\n"
      });
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
      writeManualBenchmarkFixture(root);
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
      writeManualBenchmarkFixture(root);
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
