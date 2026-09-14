import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { ApprovedSourceCandidate } from "../../src/contracts/provenance.js";
import { sha256Base64Url } from "../../src/core/hash.js";
import {
  enumerateExactOccurrences,
  exactSourceProvenanceProvider,
  localApprovedSourceAdapter,
  renderUniqueSourceLink,
  validateSourceProvenance
} from "../../src/provenance/exact.js";

function candidate(
  candidateId: string,
  text: string,
  approved = true
): ApprovedSourceCandidate {
  const bytes = Buffer.from(text, "utf8");
  return {
    candidateId,
    label: `${candidateId}.ts`,
    approved,
    bytes,
    identity: {
      sha256: sha256Base64Url(bytes),
      byteLength: bytes.length
    }
  };
}

describe("CQ-01 exact source provenance", () => {
  it("enumerates overlapping Buffer occurrences exactly", () => {
    expect(
      enumerateExactOccurrences(
        Buffer.from("aaaa", "utf8"),
        Buffer.from("aa", "utf8")
      )
    ).toEqual([0, 1, 2]);
  });

  it("distinguishes no, unique, and ambiguous approved matches", () => {
    const query = Buffer.from("const answer = 42;", "utf8");
    const unique = exactSourceProvenanceProvider.provide({
      query,
      candidates: [
        candidate("one", "prefix\nconst answer = 42;\nsuffix"),
        candidate("unapproved", "const answer = 42;", false)
      ]
    });
    expect(unique.ok && unique.value.state).toBe("unique");
    if (!unique.ok) return;
    expect(renderUniqueSourceLink(unique.value, [
      candidate("one", "prefix\nconst answer = 42;\nsuffix")
    ]).ok).toBe(true);
    expect(
      renderUniqueSourceLink(unique.value, [
        candidate("one", "prefix\nconst answer = 43;\nsuffix")
      ]).ok
    ).toBe(false);
    expect(
      renderUniqueSourceLink(unique.value, [
        candidate("one", "prefix\nconst answer = 42;\nsuffix", false)
      ]).ok
    ).toBe(false);

    const ambiguous = exactSourceProvenanceProvider.provide({
      query,
      candidates: [
        candidate(
          "many",
          "const answer = 42;\nconst answer = 42;\n"
        )
      ]
    });
    expect(ambiguous.ok && ambiguous.value.state).toBe("ambiguous");

    const none = exactSourceProvenanceProvider.provide({
      query: Buffer.from("const answer = 43;", "utf8"),
      candidates: [candidate("one", "const answer = 42;")]
    });
    expect(none.ok && none.value.state).toBe("no-match");
  });

  it("invalidates provenance after any candidate byte mutation", () => {
    const query = Buffer.from("needle", "utf8");
    const original = candidate("source", "prefix needle suffix");
    const result = exactSourceProvenanceProvider.provide({
      query,
      candidates: [original]
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(validateSourceProvenance(result.value, query, [original]).ok).toBe(
      true
    );
    expect(
      validateSourceProvenance(result.value, query, [
        candidate("source", "prefix changed suffix")
      ]).ok
    ).toBe(false);
  });

  it("captures optional Git commit/tree/blob/path/mode identity", async () => {
    const path = resolve("LICENSE");
    const captured = await localApprovedSourceAdapter.capture({
      paths: [path],
      approvedPaths: new Set([path, realpathSync(path)]),
      includeGitIdentity: true
    });

    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const git = captured.value[0]?.identity.git;
    expect(git?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git?.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(git?.blob).toMatch(/^[0-9a-f]{40}$/);
    expect(git?.mode).toMatch(/^\d{6}$/);
    expect(git?.path).toBe("LICENSE");
    expect(git?.worktreeMatchesBlob).toBe(true);
  });

  it("never renders dirty worktree-only bytes as a commit/blob link", () => {
    const source = candidate(
      "dirty-source",
      "export const clean = true;\nexport const dirtyOnly = 42;\n"
    );
    const dirtySource: ApprovedSourceCandidate = {
      ...source,
      canonicalPath: "C:\\repo\\source.ts",
      identity: {
        ...source.identity,
        git: {
          repositoryRoot: "C:\\repo",
          commit: "1".repeat(40),
          tree: "2".repeat(40),
          blob: "3".repeat(40),
          path: "source.ts",
          mode: "100644",
          worktreeMatchesBlob: false
        }
      }
    };
    const match = exactSourceProvenanceProvider.provide({
      query: Buffer.from("dirtyOnly", "utf8"),
      candidates: [dirtySource]
    });
    expect(match.ok).toBe(true);
    if (!match.ok) return;
    const link = renderUniqueSourceLink(match.value, [dirtySource]);
    expect(link.ok).toBe(true);
    if (!link.ok) return;
    expect(link.value.git).toBeUndefined();
    expect(link.value.rendered).toContain("SOURCE WORKTREE");
    expect(link.value.rendered).not.toContain("@");
  });
});
