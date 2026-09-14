import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ApprovalTarget } from "../../src/contracts/approval.js";
import { prepareContext } from "../../src/pipeline/prepare.js";
import { renderContext } from "../../src/render/render.js";
import { ContextStore } from "../../src/storage/store.js";
import {
  runTerminalReview,
  TerminalReviewController
} from "../../src/tui/review.js";
import {
  snapshotsFromManifest,
  verifyStoredRun
} from "../../src/validate/validate.js";

const target: ApprovalTarget = {
  adapterId: "offline",
  sessionId: "session-1",
  modelId: "model-1",
  workingDirectory: "C:\\repo",
  permissions: {
    sourceRead: true,
    evidenceRead: true,
    fileWrite: false,
    shell: false,
    network: false
  }
};

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ctxo-tui-"));
  const storePath = join(directory, "context.sqlite");
  const prepared = await prepareContext({
    promptText: "Summarize this routine trace.",
    contextTexts: [
      {
        label: "routine.log",
        text: "long repeated routine trace payload\n".repeat(100)
      }
    ],
    storePath
  });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const store = new ContextStore(storePath);
  const verified = verifyStoredRun(store, prepared.value.package.runId);
  if (!verified.ok) throw new Error(verified.error.message);
  const bytes = store.loadArtifactBytes(prepared.value.package.runId);
  if (!bytes.ok) throw new Error(bytes.error.message);
  const snapshots = snapshotsFromManifest(
    verified.value.manifest,
    bytes.value
  );
  if (!snapshots.ok) throw new Error(snapshots.error.message);
  const originalBytes = renderContext(
    snapshots.value,
    new Map<string, readonly never[]>(),
    verified.value.manifest.evidence
  ).preparedBytes;
  const controller = new TerminalReviewController(
    {
      contextPackage: verified.value,
      receipt: prepared.value.receipt,
      originalBytes,
      artifacts: snapshots.value,
      target
    },
    store
  );
  return { directory, store, controller, prepared: prepared.value };
}

describe("terminal-first review TUI", () => {
  it("renders review surfaces and only releases approved bytes", async () => {
    const value = await fixture();
    try {
      const view = value.controller.view();
      expect(view.summary.reconstruction).toBe("byte-identical");
      expect(view.sourceDiff.length).toBeGreaterThan(0);
      expect(view.transformations.length).toBeGreaterThan(0);
      expect(view.omissions.length).toBeGreaterThan(0);
      expect(view.security.length).toBeGreaterThan(0);
      expect(view.modelAdvice.length).toBeGreaterThan(0);
      expect(value.controller.approvedPayload().ok).toBe(false);

      expect(
        value.controller.dispatch({ type: "approve-prepared" }).ok
      ).toBe(true);
      expect(value.controller.approvedPayload().ok).toBe(true);

      value.controller.dispatch({
        type: "set-target",
        target: { ...target, modelId: "model-2" }
      });
      expect(value.controller.approvedPayload().ok).toBe(false);
    } finally {
      value.store.close();
      rmSync(value.directory, { recursive: true, force: true });
    }
  });

  it("retrieves omissions and requires fresh approval after edits", async () => {
    const value = await fixture();
    try {
      const handle = value.prepared.receipt.handles[0] as string;
      const retrieved = value.controller.dispatch({
        type: "retrieve",
        handle
      });
      expect(retrieved.ok).toBe(true);

      value.controller.dispatch({
        type: "edit-result",
        bytes: Buffer.from("edited result", "utf8")
      });
      expect(value.controller.approvedPayload().ok).toBe(false);
      expect(
        value.controller.dispatch({ type: "approve-merged" }).ok
      ).toBe(true);
      const approved = value.controller.approvedPayload();
      expect(approved.ok && approved.value.bytes.toString("utf8")).toBe(
        "edited result"
      );
    } finally {
      value.store.close();
      rmSync(value.directory, { recursive: true, force: true });
    }
  });

  it("supports an interactive approval command through injectable terminal IO", async () => {
    const value = await fixture();
    const output: (string | Uint8Array)[] = [];
    try {
      const reviewed = await runTerminalReview(value.controller, {
        question: async () => "approve",
        write: (chunk) => output.push(chunk),
        close: () => undefined
      });
      expect(reviewed.ok).toBe(true);
      expect(reviewed.ok && reviewed.value?.approval.decision).toBe(
        "approve-prepared"
      );
      expect(output.join("")).toContain("Context Overflow Review");
    } finally {
      value.store.close();
      rmSync(value.directory, { recursive: true, force: true });
    }
  });
});

