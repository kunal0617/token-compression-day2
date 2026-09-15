import {
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { exportBenchmarkSuite } from "../../src/benchmark/export.js";
import { loadBenchmarkSuite } from "../../src/benchmark/storage.js";
import { runCli } from "../../src/main.js";
import { writeManualBenchmarkFixture } from "../helpers/manual-benchmark-fixture.js";

describe("benchmark export", () => {
  it("exports selected production pairs without private absolute paths", async () => {
    const externalRoot = mkdtempSync(
      join(tmpdir(), "ctxo-benchmark-source-")
    );
    const output = resolve(
      ".context-overflow",
      `benchmark-export-${Date.now()}`
    );
    try {
      writeManualBenchmarkFixture(externalRoot);
      const exported = await exportBenchmarkSuite({
        externalRoot,
        output,
        cases: ["cq02", "cq03-incomplete", "mf01"],
        now: "2030-01-01T00:00:00.000Z"
      });
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      expect(exported.value.selectedCases).toEqual([
        "cq02",
        "cq03-incomplete",
        "mf01"
      ]);
      expect(exported.value.cases).toHaveLength(3);
      expect(
        exported.value.cases.every(
          (item) =>
            !item.original.path.includes(":") &&
            !item.storePath.includes(":")
        )
      ).toBe(true);
      const serialized = readFileSync(
        join(output, "benchmark-suite.json"),
        "utf8"
      );
      expect(serialized).not.toContain(externalRoot);
      expect(serialized).not.toContain(
        "FAIL tests/a.test.ts"
      );
      const loaded = loadBenchmarkSuite(output);
      expect(loaded.ok).toBe(true);
      expect(
        loaded.ok &&
          loaded.value.suite.cases.every(
            (item) =>
              item.original.byteLength > 0 &&
              item.prepared.byteLength > 0 &&
              item.receipt.byteLength > 0
          )
      ).toBe(true);
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("rejects unsafe output and strict CLI options", async () => {
    const externalRoot = mkdtempSync(
      join(tmpdir(), "ctxo-benchmark-source-")
    );
    try {
      writeManualBenchmarkFixture(externalRoot);
      expect(
        (
          await exportBenchmarkSuite({
            externalRoot,
            output: join(tmpdir(), "outside-benchmark")
          })
        ).ok
      ).toBe(false);
      const stderr: string[] = [];
      const exit = await runCli(
        [
          "benchmark",
          "export",
          "--root",
          externalRoot,
          "--output",
          resolve(".context-overflow", "unused"),
          "--unknown",
          "value"
        ],
        {
          stdout: () => undefined,
          stderr: (value) => stderr.push(String(value))
        }
      );
      expect(exit).toBe(2);
      expect(stderr.join("")).toContain("Unsupported option");
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });
});
