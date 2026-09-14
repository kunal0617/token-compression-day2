import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { ContextReceipt } from "../../src/contracts/types.js";
import { prepareContext } from "../../src/pipeline/prepare.js";
import { ContextStore } from "../../src/storage/store.js";
import { verifyStoredRun } from "../../src/validate/validate.js";

async function createStagingFixture() {
  const directory = mkdtempSync(join(tmpdir(), "ctxo-receipt-"));
  const storePath = join(directory, "context.sqlite");
  const promptText = "Inspect this trace.";
  const contextText = "long repeated payload for receipt binding\n".repeat(100);
  const prepared = await prepareContext({
    promptText,
    contextTexts: [{ label: "receipt.log", text: contextText }],
    storePath
  });
  if (!prepared.ok) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(prepared.error.message);
  }
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
  return {
    directory,
    storePath,
    prepared: prepared.value
  };
}

describe("receipt binding", () => {
  it("rejects structurally valid receipts that disagree with the package", async () => {
    const mutations: ((receipt: ContextReceipt) => ContextReceipt)[] = [
      (receipt) => ({ ...receipt, runId: "different-run" }),
      (receipt) => ({
        ...receipt,
        originalTokens: receipt.originalTokens + 1
      }),
      (receipt) => ({ ...receipt, handles: [] }),
      (receipt) => ({
        ...receipt,
        outcome: receipt.outcome === "red" ? "green" : "red"
      }),
      (receipt) => ({ ...receipt, readiness: "failed" })
    ];

    for (const mutate of mutations) {
      const fixture = await createStagingFixture();
      try {
        const store = new ContextStore(fixture.storePath);
        try {
          const result = store.publishValidated({
            contextPackage: fixture.prepared.package,
            receipt: mutate(fixture.prepared.receipt)
          });
          expect(result.ok).toBe(false);
          const state = store.getRunState(fixture.prepared.package.runId);
          expect(state).toEqual({
            ok: true,
            value: { status: "failed", validationStatus: "failed" }
          });
        } finally {
          store.close();
        }
      } finally {
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    }
  });

  it("validates staged SQLite artifact blobs instead of caller memory", async () => {
    const fixture = await createStagingFixture();
    try {
      const database = new DatabaseSync(fixture.storePath);
      const prompt = database
        .prepare(
          `SELECT a.digest, a.byte_length
           FROM artifacts a
           WHERE a.run_id=? AND a.role='prompt'`
        )
        .get(fixture.prepared.package.runId) as
        | { digest: string; byte_length: number }
        | undefined;
      expect(prompt).toBeDefined();
      if (prompt === undefined) throw new Error("Prompt artifact was not found");
      database
        .prepare("UPDATE blobs SET bytes=? WHERE digest=?")
        .run(Buffer.alloc(prompt.byte_length, 0x78), prompt.digest);
      database.close();

      const store = new ContextStore(fixture.storePath);
      try {
        const result = store.publishValidated({
          contextPackage: fixture.prepared.package,
          receipt: fixture.prepared.receipt
        });
        expect(result.ok).toBe(false);
        expect(store.getRunState(fixture.prepared.package.runId)).toEqual({
          ok: true,
          value: { status: "failed", validationStatus: "failed" }
        });
      } finally {
        store.close();
      }
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("rejects a canonical receipt swapped from another run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-receipt-swap-"));
    const storePath = join(directory, "context.sqlite");
    try {
      const input = {
        promptText: "Inspect this trace.",
        contextTexts: [
          {
            label: "swap.log",
            text: "long repeated payload for receipt swap\n".repeat(100)
          }
        ],
        storePath
      } as const;
      const first = await prepareContext(input);
      const second = await prepareContext(input);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      const database = new DatabaseSync(storePath);
      database
        .prepare(
          `UPDATE runs
           SET receipt_json=(SELECT receipt_json FROM runs WHERE run_id=?),
               receipt_hash=(SELECT receipt_hash FROM runs WHERE run_id=?)
           WHERE run_id=?`
        )
        .run(
          first.value.package.runId,
          first.value.package.runId,
          second.value.package.runId
        );
      database.close();

      const store = new ContextStore(storePath);
      try {
        expect(store.inspectReceipt(second.value.package.runId).ok).toBe(false);
        expect(verifyStoredRun(store, second.value.package.runId).ok).toBe(
          false
        );
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("backfills a validated historical receipt hash during migration", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-receipt-backfill-"));
    const storePath = join(directory, "context.sqlite");
    try {
      const prepared = await prepareContext({
        promptText: "Inspect this trace.",
        contextTexts: [
          {
            label: "backfill.log",
            text: "long repeated payload for receipt backfill\n".repeat(100)
          }
        ],
        storePath
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const database = new DatabaseSync(storePath);
      database
        .prepare("UPDATE runs SET receipt_hash=NULL WHERE run_id=?")
        .run(prepared.value.package.runId);
      database.close();

      const migrated = new ContextStore(storePath);
      try {
        expect(migrated.inspectReceipt(prepared.value.package.runId).ok).toBe(
          true
        );
        expect(verifyStoredRun(migrated, prepared.value.package.runId).ok).toBe(
          true
        );
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
