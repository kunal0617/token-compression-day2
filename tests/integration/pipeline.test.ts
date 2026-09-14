import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prepareContext } from "../../src/pipeline/prepare.js";
import { ContextStore } from "../../src/storage/store.js";
import { verifyStoredRun } from "../../src/validate/validate.js";

describe("end-to-end offline pipeline", () => {
  it("reduces repetition while preserving protected root-cause facts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-integration-"));
    const storePath = join(directory, "context.sqlite");
    try {
      const repeated = "Restored package cache entry for project alpha\n".repeat(
        400
      );
      const context = [
        "$ npm test",
        repeated,
        "FAIL tests/math.test.ts > adds values",
        "AssertionError: values differ",
        "Expected: 42",
        "Actual: 41",
        "Error: calculation failed",
        "  at calculate (src/math.ts:10:5)",
        "Caused by: RangeError: input out of range",
        "  at parse (src/input.ts:4:3)",
        "Tests: 1 failed, 20 passed",
        "Process exited with code 1",
        ""
      ].join("\n");

      const result = await prepareContext({
        promptText: "Fix the failing test and preserve the root cause.",
        contextTexts: [{ label: "composite.log", text: context }],
        storePath
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.receipt.tokenReductionPercent).toBeGreaterThanOrEqual(
        40
      );
      expect(result.value.receipt.integrity).toBe("verified");
      expect(result.value.receipt.reconstruction).toBe("byte-identical");
      expect(result.value.package.preparedText).toContain("Expected: 42");
      expect(result.value.package.preparedText).toContain("Actual: 41");
      expect(result.value.package.preparedText).toContain(
        "Caused by: RangeError"
      );

      const store = new ContextStore(storePath);
      try {
        const state = store.getRunState(result.value.package.runId);
        expect(state).toEqual({
          ok: true,
          value: { status: "committed", validationStatus: "validated" }
        });
        expect(store.inspectReceipt(result.value.package.runId).ok).toBe(true);
        expect(verifyStoredRun(store, result.value.package.runId).ok).toBe(true);
        for (const handle of result.value.receipt.handles) {
          expect(store.retrieve(handle).ok).toBe(true);
        }
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("prepares identical input twice in one store with distinct handles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-repeat-store-"));
    const storePath = join(directory, "context.sqlite");
    try {
      const input = {
        promptText: "Explain this trace.",
        contextTexts: [
          {
            label: "repeat.log",
            text: "long repeated package restoration payload\n".repeat(100)
          }
        ],
        storePath
      } as const;
      const first = await prepareContext(input);
      const second = await prepareContext(input);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.value.package.runId).not.toBe(second.value.package.runId);
      expect(first.value.receipt.handles[0]).not.toBe(
        second.value.receipt.handles[0]
      );

      const store = new ContextStore(storePath);
      try {
        expect(verifyStoredRun(store, first.value.package.runId).ok).toBe(true);
        expect(verifyStoredRun(store, second.value.package.runId).ok).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not let a green artifact authorize warning folding in an unknown artifact", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-local-outcome-"));
    const storePath = join(directory, "context.sqlite");
    try {
      const warnings = Array.from(
        { length: 8 },
        (_, index) =>
          `WARN 2026-09-14T09:00:0${index}Z worker-${index} delayed request for a long local warning payload in ${30 + index}ms`
      ).join("\n");
      const result = await prepareContext({
        promptText: "Inspect all artifacts.",
        contextTexts: [
          { label: "green.log", text: "Process exited with code 0\n" },
          { label: "unknown-warnings.log", text: `${warnings}\n` }
        ],
        storePath
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.receipt.outcome).toBe("unknown");
      const warningArtifact = result.value.package.manifest.artifacts.find(
        (artifact) => artifact.source.label === "unknown-warnings.log"
      );
      expect(warningArtifact?.outcome).toBe("unknown");
      expect(
        result.value.package.manifest.transforms.some(
          (transform) =>
            transform.artifactId === warningArtifact?.artifactId &&
            transform.reason === "volatile-template"
        )
      ).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps omission occurrence IDs unique across multiple artifacts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-multi-artifact-"));
    const storePath = join(directory, "context.sqlite");
    try {
      const result = await prepareContext({
        promptText: "Inspect both traces.",
        contextTexts: [
          {
            label: "first.log",
            text: "long repeated first artifact payload\n".repeat(100)
          },
          {
            label: "second.log",
            text: "long repeated second artifact payload\n".repeat(100)
          }
        ],
        storePath
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const occurrences = result.value.package.manifest.omissions.map(
        (omission) => omission.occurrenceId
      );
      expect(occurrences.length).toBeGreaterThanOrEqual(2);
      expect(new Set(occurrences).size).toBe(occurrences.length);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
