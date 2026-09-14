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

async function createFixture(newline = "\n") {
  const directory = mkdtempSync(join(tmpdir(), "ctxo-mutation-"));
  const storePath = join(directory, "context.sqlite");
  const context = [
    "large repeated payload for mutation verification",
    ...Array.from(
      { length: 80 },
      () => "large repeated payload for mutation verification"
    ),
    "$ npm test",
    "Error: duplicate failure",
    "  at first (src/a.ts:1:2)",
    "Error: duplicate failure",
    "  at second (src/b.ts:3:4)",
    "Tests: 2 failed",
    "Process exited with code 1",
    ""
  ].join(newline);
  const prepared = await prepareContext({
    promptText: "Fix both failing occurrences.",
    contextTexts: [{ label: "mutation.log", text: context }],
    storePath
  });
  if (!prepared.ok) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(prepared.error.message);
  }
  return { directory, storePath, prepared: prepared.value };
}

function rewriteManifest(
  storePath: string,
  runId: string,
  manifest: CanonicalManifest
): void {
  const json = canonicalJson(manifest);
  const digest = sha256Base64Url(Buffer.from(json, "utf8"));
  const database = new DatabaseSync(storePath);
  database
    .prepare("UPDATE manifests SET canonical_json=?, digest=? WHERE run_id=?")
    .run(json, digest, runId);
  database
    .prepare("UPDATE runs SET manifest_hash=? WHERE run_id=?")
    .run(digest, runId);
  database.close();
}

function rewritePrepared(
  storePath: string,
  runId: string,
  manifest: CanonicalManifest,
  preparedBytes: Buffer
): void {
  const digest = sha256Base64Url(preparedBytes);
  const database = new DatabaseSync(storePath);
  database
    .prepare("INSERT OR IGNORE INTO blobs(digest, size, bytes) VALUES (?, ?, ?)")
    .run(digest, preparedBytes.length, preparedBytes);
  database
    .prepare("UPDATE runs SET compact_hash=?, prepared_bytes=? WHERE run_id=?")
    .run(digest, preparedBytes.length, runId);
  database.close();
  rewriteManifest(storePath, runId, {
    ...manifest,
    compactSha256: digest,
    compactByteLength: preparedBytes.length
  });
}

function verifyFails(storePath: string, runId: string): void {
  const store = new ContextStore(storePath);
  try {
    const result = verifyStoredRun(store, runId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toMatch(
        /INTEGRITY_ERROR|HANDLE_NOT_FOUND|RUN_NOT_COMMITTED/
      );
    }
  } finally {
    store.close();
  }
}

describe("fail-closed mutations", () => {
  it("rejects manifest and database run binding mutations", async () => {
    for (const mutation of ["manifest-run", "run-hash"] as const) {
      const fixture = await createFixture();
      try {
        if (mutation === "manifest-run") {
          rewriteManifest(
            fixture.storePath,
            fixture.prepared.package.runId,
            {
              ...fixture.prepared.package.manifest,
              runId: "00000000-0000-4000-8000-000000000000"
            }
          );
        } else {
          const database = new DatabaseSync(fixture.storePath);
          database
            .prepare("UPDATE runs SET manifest_hash=? WHERE run_id=?")
            .run(
              "A".repeat(43),
              fixture.prepared.package.runId
            );
          database.close();
        }
        verifyFails(fixture.storePath, fixture.prepared.package.runId);
      } finally {
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    }
  });

  it("rejects a missing transform for a retained omission", async () => {
    const fixture = await createFixture();
    try {
      rewriteManifest(
        fixture.storePath,
        fixture.prepared.package.runId,
        {
          ...fixture.prepared.package.manifest,
          transforms: fixture.prepared.package.manifest.transforms.slice(1)
        }
      );
      verifyFails(fixture.storePath, fixture.prepared.package.runId);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("rejects an omission moved into a protected range", async () => {
    const fixture = await createFixture();
    try {
      const omission = fixture.prepared.package.manifest.omissions[0];
      expect(omission).toBeDefined();
      rewriteManifest(
        fixture.storePath,
        fixture.prepared.package.runId,
        {
          ...fixture.prepared.package.manifest,
          protectedRanges: [
            ...fixture.prepared.package.manifest.protectedRanges,
            {
              artifactId: omission?.artifactId as string,
              startByte: omission?.startByte as number,
              endByte: omission?.endByte as number,
              reasons: ["mutation"],
              evidenceIds: []
            }
          ]
        }
      );
      verifyFails(fixture.storePath, fixture.prepared.package.runId);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("rejects duplicate text occurrences mapped to the wrong literal position", async () => {
    const fixture = await createFixture();
    try {
      const evidence = fixture.prepared.package.manifest.evidence.filter(
        (item) =>
          item.kind === "exception" &&
          item.textPreview.includes("duplicate failure")
      );
      expect(evidence).toHaveLength(2);
      const mappings = fixture.prepared.package.manifest.evidenceMappings;
      const first = mappings.find(
        (mapping) => mapping.evidenceId === evidence[0]?.evidenceId
      );
      const secondId = evidence[1]?.evidenceId;
      expect(first).toBeDefined();
      rewriteManifest(
        fixture.storePath,
        fixture.prepared.package.runId,
        {
          ...fixture.prepared.package.manifest,
          evidenceMappings: mappings.map((mapping) =>
            mapping.evidenceId === secondId && first !== undefined
              ? {
                  ...mapping,
                  outputStartByte: first.outputStartByte,
                  outputEndByte: first.outputEndByte
                }
              : mapping
          )
        }
      );
      verifyFails(fixture.storePath, fixture.prepared.package.runId);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it("rejects occurrence, digest, size, range, and marker mutations", async () => {
    const mutations: ((
      manifest: CanonicalManifest
    ) => CanonicalManifest)[] = [
      (manifest) => {
        const omission = manifest.omissions[0];
        const transform = manifest.transforms[0];
        if (omission === undefined || transform === undefined) return manifest;
        return {
          ...manifest,
          omissions: [
            { ...omission, occurrenceId: `${omission.occurrenceId}-changed` },
            ...manifest.omissions.slice(1)
          ],
          transforms: [
            { ...transform, occurrenceId: `${transform.occurrenceId}-changed` },
            ...manifest.transforms.slice(1)
          ]
        };
      },
      (manifest) => {
        const omission = manifest.omissions[0];
        const transform = manifest.transforms[0];
        if (omission === undefined || transform === undefined) return manifest;
        const changedDigest = "A".repeat(43);
        return {
          ...manifest,
          omissions: [
            { ...omission, sha256: changedDigest },
            ...manifest.omissions.slice(1)
          ],
          transforms: [
            { ...transform, omittedSha256: changedDigest },
            ...manifest.transforms.slice(1)
          ]
        };
      },
      (manifest) => {
        const omission = manifest.omissions[0];
        const transform = manifest.transforms[0];
        if (omission === undefined || transform === undefined) return manifest;
        return {
          ...manifest,
          omissions: [
            { ...omission, byteLength: omission.byteLength + 1 },
            ...manifest.omissions.slice(1)
          ],
          transforms: [
            {
              ...transform,
              omittedByteLength: transform.omittedByteLength + 1
            },
            ...manifest.transforms.slice(1)
          ]
        };
      },
      (manifest) => {
        const omission = manifest.omissions[0];
        const transform = manifest.transforms[0];
        const mappingIndex = manifest.outputMappings.findIndex(
          (mapping) => mapping.handle === omission?.handle
        );
        if (
          omission === undefined ||
          transform === undefined ||
          mappingIndex < 0
        ) {
          return manifest;
        }
        return {
          ...manifest,
          omissions: [
            { ...omission, startByte: omission.startByte + 1 },
            ...manifest.omissions.slice(1)
          ],
          transforms: [
            { ...transform, startByte: transform.startByte + 1 },
            ...manifest.transforms.slice(1)
          ],
          outputMappings: manifest.outputMappings.map((mapping, index) =>
            index === mappingIndex
              ? {
                  ...mapping,
                  sourceStartByte: (mapping.sourceStartByte as number) + 1
                }
              : mapping
          )
        };
      },
      (manifest) => {
        const omission = manifest.omissions[0];
        const transform = manifest.transforms[0];
        if (omission === undefined || transform === undefined) return manifest;
        const marker = omission.marker.replace("reason=", "reason=x");
        return {
          ...manifest,
          omissions: [
            { ...omission, marker },
            ...manifest.omissions.slice(1)
          ],
          transforms: [
            { ...transform, marker },
            ...manifest.transforms.slice(1)
          ]
        };
      }
    ];

    for (const mutate of mutations) {
      const fixture = await createFixture();
      try {
        rewriteManifest(
          fixture.storePath,
          fixture.prepared.package.runId,
          mutate(fixture.prepared.package.manifest)
        );
        verifyFails(fixture.storePath, fixture.prepared.package.runId);
      } finally {
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    }
  });

  it("rejects manifest corruption and missing or flipped blobs", async () => {
    for (const mutation of ["manifest", "flip", "delete"] as const) {
      const fixture = await createFixture();
      try {
        const database = new DatabaseSync(fixture.storePath);
        if (mutation === "manifest") {
          database
            .prepare(
              "UPDATE manifests SET canonical_json=canonical_json || ' ' WHERE run_id=?"
            )
            .run(fixture.prepared.package.runId);
        } else {
          const omission = fixture.prepared.package.manifest.omissions[0];
          expect(omission).toBeDefined();
          if (omission === undefined) {
            throw new Error("Expected at least one omission");
          }
          if (mutation === "flip") {
            const bytes = Buffer.alloc(omission.byteLength, 0x78);
            database
              .prepare("UPDATE blobs SET bytes=? WHERE digest=?")
              .run(bytes, omission.sha256);
          } else {
            database.exec("PRAGMA foreign_keys=OFF");
            database
              .prepare("DELETE FROM blobs WHERE digest=?")
              .run(omission.sha256);
          }
        }
        database.close();
        verifyFails(fixture.storePath, fixture.prepared.package.runId);
      } finally {
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    }
  });

  it("rejects synthetic/protected output changes and CRLF normalization", async () => {
    for (const mutation of ["synthetic-byte", "protected-byte", "crlf"] as const) {
      const fixture = await createFixture("\r\n");
      try {
        const bytes = Buffer.from(fixture.prepared.package.preparedBytes);
        let mutated: Buffer;
        if (mutation === "synthetic-byte") {
          const mapping =
            fixture.prepared.package.manifest.outputMappings.find(
              (item) => item.kind === "synthetic"
            );
          expect(mapping).toBeDefined();
          mutated = Buffer.from(bytes);
          const offset = mapping?.outputStartByte as number;
          mutated[offset] = mutated[offset] === 0x78 ? 0x79 : 0x78;
        } else if (mutation === "protected-byte") {
          const mapping =
            fixture.prepared.package.manifest.evidenceMappings[0];
          expect(mapping).toBeDefined();
          mutated = Buffer.from(bytes);
          const offset = mapping?.outputStartByte as number;
          mutated[offset] = mutated[offset] === 0x78 ? 0x79 : 0x78;
        } else {
          mutated = Buffer.from(
            bytes.toString("utf8").replace(/\r\n/g, "\n"),
            "utf8"
          );
        }
        rewritePrepared(
          fixture.storePath,
          fixture.prepared.package.runId,
          fixture.prepared.package.manifest,
          mutated
        );
        verifyFails(fixture.storePath, fixture.prepared.package.runId);
      } finally {
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    }
  });
});
