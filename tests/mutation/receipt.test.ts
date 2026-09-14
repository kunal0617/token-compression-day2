import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { ContextReceipt } from "../../src/contracts/types.js";
import { prepareContext } from "../../src/pipeline/prepare.js";
import { ContextStore } from "../../src/storage/store.js";
import { snapshotsFromManifest } from "../../src/validate/validate.js";

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
  const reader = new ContextStore(storePath);
  const artifactBytes = reader.loadArtifactBytes(prepared.value.package.runId);
  reader.close();
  if (!artifactBytes.ok) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(artifactBytes.error.message);
  }
  const snapshots = snapshotsFromManifest(
    prepared.value.package.manifest,
    artifactBytes.value
  );
  if (!snapshots.ok) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(snapshots.error.message);
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
    prepared: prepared.value,
    snapshots: snapshots.value
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
            artifacts: fixture.snapshots,
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
});

