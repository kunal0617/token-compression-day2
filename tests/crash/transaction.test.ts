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

  it("holds a write lock from validation through publication decision", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-validation-lock-"));
    const storePath = join(directory, "context.sqlite");
    try {
      const prepared = await prepareContext({
        promptText: "Inspect this trace.",
        contextTexts: [
          {
            label: "lock.log",
            text: "long repeated payload for validation locking\n".repeat(100)
          }
        ],
        storePath
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const setup = new DatabaseSync(storePath);
      setup
        .prepare(
          `UPDATE runs
           SET status='staging', validation_status='pending',
               committed_at=NULL, receipt_json=NULL
           WHERE run_id=?`
        )
        .run(prepared.value.package.runId);
      setup.close();

      const store = new ContextStore(storePath);
      try {
        expect(store.beginValidation(prepared.value.package.runId).ok).toBe(
          true
        );
        const competing = new DatabaseSync(storePath);
        competing.exec("PRAGMA busy_timeout=1");
        expect(() =>
          competing
            .prepare("UPDATE manifests SET canonical_json='tampered' WHERE run_id=?")
            .run(prepared.value.package.runId)
        ).toThrow();
        competing.close();
        expect(
          store.cancelValidation(
            prepared.value.package.runId,
            "intentional lock test"
          ).ok
        ).toBe(true);
        expect("finalizeValidated" in store).toBe(false);
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records a failed run when atomic publication is rejected", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-finalize-failure-"));
    const storePath = join(directory, "context.sqlite");
    try {
      const initialized = new ContextStore(storePath);
      initialized.close();
      const database = new DatabaseSync(storePath);
      database.exec(`
        CREATE TRIGGER fail_publication
        BEFORE UPDATE OF status ON runs
        WHEN NEW.status = 'committed'
        BEGIN
          SELECT RAISE(ABORT, 'simulated publication failure');
        END;
      `);
      database.close();

      const result = await prepareContext({
        promptText: "Inspect this trace.",
        contextTexts: [
          {
            label: "publication.log",
            text: "long repeated payload for publication failure\n".repeat(100)
          }
        ],
        storePath
      });
      expect(result.ok).toBe(false);

      const inspection = new DatabaseSync(storePath, { readOnly: true });
      const runs = inspection
        .prepare("SELECT status, validation_status FROM runs")
        .all() as unknown as {
        status: string;
        validation_status: string;
      }[];
      inspection.close();
      expect(runs).toEqual([
        { status: "failed", validation_status: "failed" }
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
