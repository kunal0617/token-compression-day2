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
});

