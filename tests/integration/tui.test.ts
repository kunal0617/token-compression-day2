import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ApprovalTarget } from "../../src/contracts/approval.js";
import type { EvidenceRetrievalAdapter } from "../../src/contracts/obligations.js";
import type { CurrentSourceReadPort } from "../../src/contracts/tui.js";
import { sha256Base64Url } from "../../src/core/hash.js";
import { prepareContext } from "../../src/pipeline/prepare.js";
import { createEvidenceFact } from "../../src/obligations/evaluate.js";
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
import { CommittedRunScopeAuthority } from "../../src/adapters/run-authority.js";
import { OfflineHandoffPort } from "../../src/ports/handoff.js";

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

async function fixture(
  currentSource?: CurrentSourceReadPort,
  promptText = "Fix the failure while summarizing this routine trace.",
  contextText = "long repeated routine trace payload\n".repeat(100),
  retrievalAdapters?: ReadonlyMap<string, EvidenceRetrievalAdapter>
) {
  const directory = mkdtempSync(join(tmpdir(), "ctxo-tui-"));
  const storePath = join(directory, "context.sqlite");
  const prepared = await prepareContext({
    promptText,
    contextTexts: [
      {
        label: "routine.log",
        text: contextText
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
      capturedBytes: originalBytes,
      artifacts: snapshots.value,
      readScope: {
        runId: verified.value.runId,
        evidence: verified.value.manifest.evidence.map((evidence) => {
          const artifact = snapshots.value.find(
            (item) => item.artifactId === evidence.artifactId
          ) as (typeof snapshots.value)[number];
          return {
            span: evidence,
            bytes: artifact.bytes.subarray(
              evidence.startByte,
              evidence.endByte
            )
          };
        }),
        sources: []
      },
      ...(retrievalAdapters === undefined
        ? {}
        : { retrievalAdapters }),
      approvalAuthority: new CommittedRunScopeAuthority(
        store,
        [],
        [...(retrievalAdapters?.values() ?? [])].map(
          (adapter) => adapter.metadata
        )
      ),
      ...(currentSource === undefined ? {} : { currentSource }),
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

  it("recaptures current files and invalidates approval when they change during review", async () => {
    let currentBytes = Buffer.from("current-one", "utf8");
    let currentSourceId = "current-file";
    const port: CurrentSourceReadPort = {
      capture: () => ({
        ok: true,
        value: {
          bytes: Buffer.from(currentBytes),
          sourceIdentities: [
            {
              sourceId: currentSourceId,
              identity: {
                sha256: sha256Base64Url(currentBytes),
                byteLength: currentBytes.length
              }
            }
          ]
        }
      })
    };
    const value = await fixture(port);
    try {
      expect(
        value.controller.dispatch({
          type: "choose-snapshot",
          choice: "current"
        }).ok
      ).toBe(true);
      currentBytes = Buffer.from("current-two", "utf8");
      expect(
        value.controller.dispatch({ type: "approve-selected" }).ok
      ).toBe(false);
      expect(value.controller.approvedPayload().ok).toBe(false);

      expect(
        value.controller.dispatch({
          type: "choose-snapshot",
          choice: "current"
        }).ok
      ).toBe(true);
      expect(
        value.controller.dispatch({ type: "approve-selected" }).ok
      ).toBe(true);
      expect(value.controller.approvedPayload().ok).toBe(true);
      currentSourceId = "renamed-current-file";
      expect(value.controller.approvedPayload().ok).toBe(false);
    } finally {
      value.store.close();
      rmSync(value.directory, { recursive: true, force: true });
    }
  });

  it("persists gathered facts and re-evaluates gaps before approval", async () => {
    let retrievalCalls = 0;
    let expectedGap:
      | ReturnType<TerminalReviewController["view"]>["gaps"][number]
      | undefined;
    const adapter: EvidenceRetrievalAdapter = {
      metadata: {
        producerId: "source-read",
        kind: "source-adapter",
        version: "1.0.0",
        digest: sha256Base64Url(
          Buffer.from("test.source-read", "utf8")
        )
      },
      retrieve: async (request) => {
        retrievalCalls += 1;
        if (expectedGap === undefined) {
          throw new Error("Expected gap was not selected");
        }
        const value = "validated failure block";
        const bytes = Buffer.from(value, "utf8");
        return {
          ok: true,
          value: [
            createEvidenceFact({
              obligationId: request.obligationId,
              kind: "referenced-source",
              key: expectedGap.key,
              value,
              evidenceIds: ["retrieved-failure-block"],
              artifactId: request.artifactId ?? "retrieved-source",
              startByte: 0,
              endByte: bytes.length,
              sha256: sha256Base64Url(bytes),
              byteLength: bytes.length,
              origin: "bounded-retrieval"
            })
          ]
        };
      }
    };
    const value = await fixture(
      undefined,
      "Fix the failure.",
      [
        "TypeError: broken",
        "  at run (src/app.ts:2:3)",
        "Process exited with code 1",
        ""
      ].join("\n"),
      new Map([["source-read", adapter]])
    );
    try {
      const gap = value.controller.view().gaps.find(
        (item) => item.kind === "referenced-source"
      );
      expect(gap).toBeDefined();
      expect(
        value.controller.dispatch({ type: "approve-prepared" }).ok
      ).toBe(false);
      if (gap === undefined) return;
      expectedGap = gap;
      expect((await value.controller.gatherEvidence()).ok).toBe(true);
      expect(retrievalCalls).toBe(1);
      expect(
        "saveEvidenceRetrievalReceipts" in value.store
      ).toBe(false);
      expect(value.controller.view().gaps).toHaveLength(0);
      expect(
        value.controller.dispatch({ type: "approve-prepared" }).ok
      ).toBe(true);
      const completed = verifyStoredRun(
        value.store,
        value.prepared.package.runId
      );
      expect(
        completed.ok && completed.value.validation.evidenceDecision
      ).toBe("ready");
      if (completed.ok) {
        expect(
          (await new OfflineHandoffPort().handoff(completed.value)).ok
        ).toBe(true);
      }

      const persisted = value.store.loadReviewFacts(
        value.prepared.package.runId
      );
      expect(persisted.ok && persisted.value).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ obligationId: gap.obligationId })
        ])
      );
      expect(
        persisted.ok &&
          persisted.value[0]?.retrievalBinding?.adapter.producerId
      ).toBe("source-read");
    } finally {
      value.store.close();
      rmSync(value.directory, { recursive: true, force: true });
    }
  });
});
