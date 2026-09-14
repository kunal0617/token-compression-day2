import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CommittedRunScopeAuthority } from "../../src/adapters/run-authority.js";
import { prepareContext } from "../../src/pipeline/prepare.js";
import { ContextStore } from "../../src/storage/store.js";
import { snapshotsFromManifest } from "../../src/validate/validate.js";
import { sha256Base64Url } from "../../src/core/hash.js";

describe("committed run read-scope authority", () => {
  it("validates evidence and source bytes against committed snapshots", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-run-authority-"));
    const storePath = join(directory, "context.sqlite");
    try {
      const prepared = await prepareContext({
        promptText: "Inspect the command exit.",
        contextTexts: [
          {
            label: "authority.log",
            text: "$ demo\nProcess exited with code 0\n"
          }
        ],
        storePath
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const store = new ContextStore(storePath);
      try {
        const bytes = store.loadArtifactBytes(prepared.value.package.runId);
        expect(bytes.ok).toBe(true);
        if (!bytes.ok) return;
        const snapshots = snapshotsFromManifest(
          prepared.value.package.manifest,
          bytes.value
        );
        expect(snapshots.ok).toBe(true);
        if (!snapshots.ok) return;
        const evidence = prepared.value.package.manifest.evidence[0];
        expect(evidence).toBeDefined();
        if (evidence === undefined) return;
        const artifact = snapshots.value.find(
          (item) => item.artifactId === evidence.artifactId
        );
        expect(artifact).toBeDefined();
        if (artifact === undefined) return;
        const sourceBytes = Buffer.from("export const value = 1;", "utf8");
        const source = {
          sourceId: "source",
          path: "source.ts",
          startByte: 0,
          endByte: sourceBytes.length,
          bytes: sourceBytes,
          sha256: sha256Base64Url(sourceBytes),
          unitIds: ["unit"]
        };
        const authority = new CommittedRunScopeAuthority(store, [source]);
        const scope = {
          runId: prepared.value.package.runId,
          evidence: [
            {
              span: evidence,
              bytes: artifact.bytes.subarray(
                evidence.startByte,
                evidence.endByte
              )
            }
          ],
          sources: [source]
        };
        expect(authority.validate(scope.runId, scope).ok).toBe(true);
        const originalSource = {
          ...source,
          bytes: Buffer.from(sourceBytes),
          unitIds: [...source.unitIds]
        };
        source.bytes.fill(0x78);
        expect(
          authority.validate(scope.runId, {
            ...scope,
            sources: [originalSource]
          }).ok
        ).toBe(true);
        const scopedEvidence = scope.evidence[0];
        expect(scopedEvidence).toBeDefined();
        if (scopedEvidence === undefined) return;
        expect(
          authority.validate(scope.runId, {
            ...scope,
            evidence: [
              {
                ...scopedEvidence,
                bytes: Buffer.from("tampered", "utf8")
              }
            ]
          }).ok
        ).toBe(false);
        expect(
          authority.validate(scope.runId, {
            ...scope,
            sources: [{ ...source, bytes: Buffer.from(sourceBytes).fill(0x78) }]
          }).ok
        ).toBe(false);
        expect(
          authority.validate(scope.runId, {
            ...scope,
            sources: [{ ...originalSource, path: "forged.ts" }]
          }).ok
        ).toBe(false);
        expect(
          authority.validate(scope.runId, {
            ...scope,
            evidence: [
              {
                ...scopedEvidence,
                span: {
                  ...scopedEvidence.span,
                  kind: "identifier"
                }
              }
            ],
            sources: [originalSource]
          }).ok
        ).toBe(false);
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
