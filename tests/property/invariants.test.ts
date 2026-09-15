import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { prepareContext } from "../../src/pipeline/prepare.js";
import { ContextStore } from "../../src/storage/store.js";
import { verifyStoredRun } from "../../src/validate/validate.js";

describe("pipeline properties", () => {
  it(
    "reconstructs arbitrary repeated UTF-8 line sequences and resolves every handle",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "ctxo-property-"));
      let sequence = 0;
      try {
        await fc.assert(
          fc.asyncProperty(
            fc.array(fc.integer({ min: 0, max: 1_000_000 }), {
              minLength: 1,
              maxLength: 12
            }),
            async (values) => {
              const lines = values.map((value) => `payload-${value}\n`).join("");
              const storePath = join(directory, `run-${sequence}.sqlite`);
              sequence += 1;
              const result = await prepareContext({
                promptText: "Explain this deterministic trace.",
                contextTexts: [
                  {
                    label: "property.log",
                    text: lines.repeat(6)
                  }
                ],
                storePath
              });
              expect(result.ok).toBe(true);
              if (!result.ok) return;
              const evidence = result.value.package.manifest.evidence;
              expect(new Set(evidence.map((item) => item.occurrenceId)).size).toBe(
                evidence.length
              );
              expect(
                new Set(
                  result.value.package.manifest.transforms.map(
                    (item) =>
                      `${item.artifactId}:${item.startByte}:${item.endByte}`
                  )
                ).size
              ).toBe(result.value.package.manifest.transforms.length);

              const store = new ContextStore(storePath);
              try {
                expect(
                  verifyStoredRun(store, result.value.package.runId).ok
                ).toBe(true);
                for (const handle of result.value.receipt.handles) {
                  expect(store.retrieve(handle).ok).toBe(true);
                }
              } finally {
                store.close();
              }
            }
          ),
          { numRuns: 12, seed: 20260914 }
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    60_000
  );
});

