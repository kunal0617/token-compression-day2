import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { prepareContext } from "../../src/pipeline/prepare.js";
import { ContextStore } from "../../src/storage/store.js";

describe("transaction and visibility failures", () => {
  it("rolls back all run data when staging fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-crash-"));
    const storePath = join(directory, "context.sqlite");
    try {
      const initialized = new ContextStore(storePath);
      initialized.close();
      const database = new DatabaseSync(storePath);
      database.exec(`
        CREATE TRIGGER fail_omission
        BEFORE INSERT ON omissions
        BEGIN
          SELECT RAISE(ABORT, 'simulated staging crash');
        END;
      `);
      database.close();

      const result = await prepareContext({
        promptText: "Inspect this trace.",
        contextTexts: [
          {
            label: "crash.log",
            text: "large repeated payload for transaction testing\n".repeat(100)
          }
        ],
        storePath
      });
      expect(result.ok).toBe(false);

      const inspection = new DatabaseSync(storePath, { readOnly: true });
      const artifacts = inspection
        .prepare("SELECT count(*) AS count FROM artifacts")
        .get() as { count: number };
      const manifests = inspection
        .prepare("SELECT count(*) AS count FROM manifests")
        .get() as { count: number };
      const runs = inspection
        .prepare("SELECT status FROM runs")
        .all() as unknown as { status: string }[];
      inspection.close();
      expect(artifacts.count).toBe(0);
      expect(manifests.count).toBe(0);
      expect(runs).toEqual([{ status: "failed" }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not expose crash-left staging runs through public reads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-staging-"));
    const storePath = join(directory, "context.sqlite");
    try {
      const prepared = await prepareContext({
        promptText: "Inspect this trace.",
        contextTexts: [
          {
            label: "staging.log",
            text: "large repeated payload for staging visibility\n".repeat(100)
          }
        ],
        storePath
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const database = new DatabaseSync(storePath);
      database
        .prepare(
          `UPDATE runs
           SET status='staging', validation_status='pending',
               committed_at=NULL, receipt_json=NULL
           WHERE run_id=?`
        )
        .run(prepared.value.package.runId);
      database.close();

      const store = new ContextStore(storePath);
      try {
        expect(store.loadManifest(prepared.value.package.runId).ok).toBe(false);
        expect(
          store.inspectReceipt(prepared.value.package.runId).ok
        ).toBe(false);
        for (const handle of prepared.value.receipt.handles) {
          expect(store.retrieve(handle).ok).toBe(false);
        }
        expect(
          store.loadManifestForValidation(prepared.value.package.runId).ok
        ).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

