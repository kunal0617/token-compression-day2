import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { exportBenchmarkSuite } from "../../src/benchmark/export.js";
import { prepareOutputDirectory } from "../../src/benchmark/io.js";
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

  it("rejects suite links, swapped payloads, and mutated stores", async () => {
    const externalRoot = mkdtempSync(
      join(tmpdir(), "ctxo-benchmark-binding-source-")
    );
    const suiteRoot = resolve(
      ".context-overflow",
      `benchmark-binding-suite-${Date.now()}`
    );
    const outside = mkdtempSync(
      join(tmpdir(), "ctxo-benchmark-outside-suite-")
    );
    const link = resolve(
      ".context-overflow",
      `benchmark-suite-link-${Date.now()}`
    );
    const parentLink = resolve(
      ".context-overflow",
      `benchmark-suite-parent-link-${Date.now()}`
    );
    try {
      writeManualBenchmarkFixture(externalRoot);
      const exported = await exportBenchmarkSuite({
        externalRoot,
        output: suiteRoot,
        cases: ["cq02", "cq04"]
      });
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      expect(loadBenchmarkSuite(suiteRoot).ok).toBe(true);

      cpSync(suiteRoot, outside, { recursive: true });
      symlinkSync(outside, link, "junction");
      expect(loadBenchmarkSuite(link).ok).toBe(false);
      rmSync(link, { recursive: true, force: true });
      symlinkSync(outside, parentLink, "junction");
      expect(
        loadBenchmarkSuite(parentLink).ok
      ).toBe(false);
      expect(
        prepareOutputDirectory(
          join(parentLink, "escaped-run"),
          { allowExisting: false }
        ).ok
      ).toBe(false);
      rmSync(parentLink, { recursive: true, force: true });

      const originalA = join(
        suiteRoot,
        "cases",
        "cq02",
        "original.bin"
      );
      const originalB = join(
        suiteRoot,
        "cases",
        "cq04",
        "original.bin"
      );
      const first = readFileSync(originalA);
      writeFileSync(originalA, readFileSync(originalB));
      expect(loadBenchmarkSuite(suiteRoot).ok).toBe(false);
      writeFileSync(originalA, first);

      const storePath = join(
        suiteRoot,
        "cases",
        "cq02",
        "context.sqlite"
      );
      const storeBytes = readFileSync(storePath);
      storeBytes[100] = (storeBytes[100] ?? 0) ^ 1;
      writeFileSync(storePath, storeBytes);
      expect(loadBenchmarkSuite(suiteRoot).ok).toBe(false);
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
      rmSync(suiteRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      rmSync(link, { force: true });
      rmSync(parentLink, { recursive: true, force: true });
    }
  });

  it("returns typed root and UTF-8 failures without partial output", async () => {
    const missingOutput = resolve(
      ".context-overflow",
      `benchmark-missing-root-${Date.now()}`
    );
    const missing = await exportBenchmarkSuite({
      externalRoot: join(tmpdir(), "missing-benchmark-root"),
      output: missingOutput
    });
    expect(missing.ok).toBe(false);
    expect(existsSync(missingOutput)).toBe(false);

    const externalRoot = mkdtempSync(
      join(tmpdir(), "ctxo-benchmark-invalid-utf8-")
    );
    const invalidOutput = resolve(
      ".context-overflow",
      `benchmark-invalid-utf8-${Date.now()}`
    );
    try {
      writeManualBenchmarkFixture(externalRoot);
      writeFileSync(
        join(
          externalRoot,
          "cq02-diagnostics",
          "request.txt"
        ),
        Buffer.from([0xff, 0xfe, 0xfd])
      );
      const invalid = await exportBenchmarkSuite({
        externalRoot,
        output: invalidOutput,
        cases: ["cq02"]
      });
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) {
        expect(invalid.error.code).toBe("INVALID_UTF8");
        expect(
          JSON.stringify(invalid.error)
        ).not.toContain(externalRoot);
      }
      expect(existsSync(invalidOutput)).toBe(false);
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
      rmSync(invalidOutput, { recursive: true, force: true });
    }
  });
});
