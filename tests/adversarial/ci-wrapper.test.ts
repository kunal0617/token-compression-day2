import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { prepareContext } from "../../src/pipeline/prepare.js";
import { ContextStore } from "../../src/storage/store.js";
import { verifyStoredRun } from "../../src/validate/validate.js";

describe("GitHub Actions wrapper reduction", () => {
  it("folds wrapper groups while preserving failure and metrics evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-ci-wrapper-"));
    const storePath = join(directory, "context.sqlite");
    try {
      const result = await prepareContext({
        promptText:
          "Diagnose the failed CI job and preserve job, run, branch, image, artifact, and metrics evidence.",
        contextFiles: [
          resolve("fixtures\\github-actions-metrics-synthetic.log")
        ],
        storePath
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.receipt.outcome).toBe("red");
      expect(result.value.receipt.tokenReductionPercent).toBeGreaterThanOrEqual(
        30
      );
      expect(result.value.receipt.handles.length).toBeGreaterThan(0);
      expect(result.value.receipt.protectedEvidence.length).toBeLessThan(100);
      expect(
        result.value.receipt.warnings.some((warning) =>
          warning.includes("detailed failing job log")
        )
      ).toBe(true);

      const prepared = result.value.package.preparedText;
      for (const required of [
        '\"conclusion\": \"failure\"',
        '\"name\": \"test (linux-image-build)\"',
        '\"name\": \"Set up job\"',
        "branch: release-demo",
        "image-name: demo-image-2031",
        '"run_id": 424242',
        "Found 0 artifact(s)",
        "Total of 0 artifact(s) downloaded",
        "demo.ci.workflow_success_percent",
        "failed_count: 1",
        "success_percent: 0",
        "##[warning]Node.js 20 is deprecated"
      ]) {
        expect(prepared).toContain(required);
      }
      expect(
        result.value.package.manifest.evidence.some(
          (item) =>
            item.kind === "source-location" &&
            item.textPreview.includes("2031-04-05T")
        )
      ).toBe(false);

      const store = new ContextStore(storePath);
      try {
        expect(verifyStoredRun(store, result.value.package.runId).ok).toBe(true);
        for (const handle of result.value.receipt.handles) {
          expect(store.retrieve(handle).ok).toBe(true);
        }
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reduces a copied transcript with BOM mojibake and stripped ESC bytes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-ci-copied-"));
    const storePath = join(directory, "context.sqlite");
    const source = readFileSync(
      resolve("fixtures\\github-actions-metrics-synthetic.log"),
      "utf8"
    ).replace(/^\uFEFF/u, "");
    const copied = `\u00ef\u00bb\u00bf${source.replace(/\u001b/g, "")}`;
    try {
      const result = await prepareContext({
        promptText:
          "Diagnose the failed copied CI transcript and preserve failure metadata.",
        contextTexts: [{ label: "copied-ci.log", text: copied }],
        storePath
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.receipt.tokenReductionPercent).toBeGreaterThanOrEqual(
        30
      );
      expect(result.value.receipt.handles.length).toBeGreaterThan(0);
      expect(result.value.receipt.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("detailed failing job log")
        ])
      );
      for (const required of [
        '"name": "test (linux-image-build)"',
        '"name": "Set up job"',
        '"conclusion": "failure"',
        "branch: release-demo",
        "image-name: demo-image-2031",
        "Found 0 artifact(s)",
        "demo.ci.workflow_success_percent",
        "##[warning]Node.js 20 is deprecated"
      ]) {
        expect(result.value.package.preparedText).toContain(required);
      }
      const sourceArtifact = result.value.package.manifest.artifacts.find(
        (artifact) => artifact.source.label === "copied-ci.log"
      );
      expect(sourceArtifact?.byteLength).toBe(Buffer.byteLength(copied, "utf8"));

      const store = new ContextStore(storePath);
      try {
        expect(verifyStoredRun(store, result.value.package.runId).ok).toBe(true);
        for (const handle of result.value.receipt.handles) {
          expect(store.retrieve(handle).ok).toBe(true);
        }
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
