import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { CanonicalManifest } from "../../src/contracts/types.js";
import { canonicalJson } from "../../src/core/canonical.js";
import { sha256Base64Url } from "../../src/core/hash.js";
import { prepareContext } from "../../src/pipeline/prepare.js";
import { ContextStore } from "../../src/storage/store.js";
import { verifyStoredRun } from "../../src/validate/validate.js";

describe("producer registry migration", () => {
  it("keeps legacy v1 committed runs verifiable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-registry-v1-"));
    const storePath = join(directory, "context.sqlite");
    try {
      const prepared = await prepareContext({
        promptText: "Inspect this trace.",
        contextTexts: [
          {
            label: "legacy.log",
            text: "long repeated legacy payload\n".repeat(100)
          }
        ],
        storePath
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const {
        producerRegistry: _producerRegistry,
        ...manifestWithoutRegistry
      } = prepared.value.package.manifest;
      const legacyManifest: CanonicalManifest = {
        ...manifestWithoutRegistry,
        formatVersion: 1
      };
      const parsed = JSON.parse(canonicalJson(legacyManifest)) as Record<
        string,
        unknown
      >;
      delete parsed.producerRegistry;
      const manifestJson = canonicalJson(parsed);
      const digest = sha256Base64Url(Buffer.from(manifestJson, "utf8"));
      const database = new DatabaseSync(storePath);
      database.exec("BEGIN IMMEDIATE");
      database
        .prepare(
          "UPDATE manifests SET canonical_json=?, digest=? WHERE run_id=?"
        )
        .run(manifestJson, digest, prepared.value.package.runId);
      database
        .prepare("UPDATE runs SET manifest_hash=? WHERE run_id=?")
        .run(digest, prepared.value.package.runId);
      database
        .prepare("DELETE FROM run_producers WHERE run_id=?")
        .run(prepared.value.package.runId);
      database.exec("COMMIT");
      database.close();

      const store = new ContextStore(storePath);
      try {
        expect(verifyStoredRun(store, prepared.value.package.runId).ok).toBe(
          true
        );
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when v2 producer metadata is removed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-registry-v2-"));
    const storePath = join(directory, "context.sqlite");
    try {
      const prepared = await prepareContext({
        promptText: "Inspect this trace.",
        contextTexts: [
          {
            label: "v2.log",
            text: "long repeated v2 payload\n".repeat(100)
          }
        ],
        storePath
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const database = new DatabaseSync(storePath);
      database
        .prepare("DELETE FROM run_producers WHERE run_id=?")
        .run(prepared.value.package.runId);
      database.close();

      const store = new ContextStore(storePath);
      try {
        expect(verifyStoredRun(store, prepared.value.package.runId).ok).toBe(
          false
        );
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
