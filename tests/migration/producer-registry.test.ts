import {
  copyFileSync,
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { VersionedProducer } from "../../src/contracts/providers.js";
import { sha256Base64Url } from "../../src/core/hash.js";
import { prepareContext } from "../../src/pipeline/prepare.js";
import { ContextStore } from "../../src/storage/store.js";
import { verifyStoredRun } from "../../src/validate/validate.js";
import {
  producerSnapshotMatchesRegistry,
  VersionedRegistry
} from "../../src/registry/registry.js";

describe("producer registry migration", () => {
  it("keeps a store produced by the actual v1 implementation verifiable", () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-registry-v1-"));
    const storePath = join(directory, "context.sqlite");
    const runId = "a3895336-1cc6-42ce-9f5f-7258a96ef291";
    try {
      copyFileSync(
        resolve("fixtures", "migration", "v1-store.sqlite"),
        storePath
      );
      const store = new ContextStore(storePath);
      try {
        const verified = verifyStoredRun(store, runId);
        expect(verified.ok).toBe(true);
        if (!verified.ok) return;
        expect(verified.value.manifest.formatVersion).toBe(1);
        expect(verified.value.manifest.policy).toBeUndefined();
        expect(
          verified.value.manifest.artifacts.every(
            (artifact) => artifact.outcome === undefined
          )
        ).toBe(true);
        expect(
          store.retrieve(
            verified.value.manifest.omissions[0]?.handle ?? ""
          ).ok
        ).toBe(true);
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

  it("verifies a prepared producer snapshot after unrelated registry evolution", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-registry-evolve-"));
    const storePath = join(directory, "context.sqlite");
    try {
      const prepared = await prepareContext({
        promptText: "Inspect this trace.",
        contextTexts: [
          {
            label: "evolve.log",
            text: "long repeated evolution payload\n".repeat(100)
          }
        ],
        storePath
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const producers =
        prepared.value.package.manifest.producerRegistry?.producers ?? [];
      const evolved = new VersionedRegistry<VersionedProducer>();
      for (const metadata of producers) {
        expect(evolved.register({ metadata }).ok).toBe(true);
      }
      expect(
        evolved.register({
          metadata: {
            producerId: "test.unrelated-new-provider",
            kind: "detector",
            version: "1.0.0",
            digest: sha256Base64Url(Buffer.from("unrelated", "utf8"))
          }
        }).ok
      ).toBe(true);
      expect(producerSnapshotMatchesRegistry(producers, evolved)).toBe(true);

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
});
