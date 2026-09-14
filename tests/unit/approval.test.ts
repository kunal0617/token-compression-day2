import { describe, expect, it } from "vitest";

import type { ReviewSubject } from "../../src/contracts/approval.js";
import { canonicalJsonDigest } from "../../src/core/canonical.js";
import { sha256Base64Url } from "../../src/core/hash.js";
import {
  approveReviewSubject,
  compareSnapshots,
  createDiff3Merge,
  reviewSubjectProvider,
  selectSnapshot,
  validateApproval
} from "../../src/approval/review.js";

function subject(payload = Buffer.from("prepared", "utf8")) {
  return reviewSubjectProvider.provide({
    runId: "run-1",
    payload,
    sourceIdentities: [
      {
        sourceId: "source-1",
        identity: {
          sha256: sha256Base64Url(Buffer.from("source", "utf8")),
          byteLength: 6
        }
      }
    ],
    policyDigest: canonicalJsonDigest("policy"),
    detectorRegistryDigest: canonicalJsonDigest("detectors"),
    tokenizer: "o200k_base",
    target: {
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
    },
    snapshotChoice: "captured",
    createdAt: "2030-01-01T00:00:00.000Z"
  });
}

describe("CQ-07 snapshot and approval binding", () => {
  it("compares and selects captured/current/both snapshots", () => {
    const captured = Buffer.from("captured", "utf8");
    const current = Buffer.from("current", "utf8");
    expect(compareSnapshots(captured, captured).state).toBe("unchanged");
    expect(compareSnapshots(captured, current).state).toBe("changed");
    expect(
      selectSnapshot({ choice: "captured", captured, current }).ok
    ).toBe(true);
    expect(
      selectSnapshot({ choice: "current", captured, current }).ok
    ).toBe(true);
    const both = selectSnapshot({ choice: "both", captured, current });
    expect(both.ok && both.value.bytes.toString("utf8")).toContain("[CURRENT]");
    expect(
      selectSnapshot({ choice: "cancel", captured, current }).ok
    ).toBe(false);
  });

  it("binds approval to payload, sources, policy, registry, target, cwd, and permissions", () => {
    const payload = Buffer.from("prepared", "utf8");
    const created = subject(payload);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const approval = approveReviewSubject({
      subject: created.value,
      payload,
      decision: "approve-prepared",
      approvedAt: "2030-01-01T00:01:00.000Z"
    });
    expect(approval.ok).toBe(true);
    if (!approval.ok) return;
    expect(
      validateApproval({
        subject: created.value,
        approval: approval.value,
        payload
      }).ok
    ).toBe(true);

    const mutations: ReviewSubject[] = [
      {
        ...created.value,
        target: { ...created.value.target, modelId: "model-2" }
      },
      {
        ...created.value,
        target: {
          ...created.value.target,
          workingDirectory: "C:\\other"
        }
      },
      {
        ...created.value,
        target: {
          ...created.value.target,
          permissions: {
            ...created.value.target.permissions,
            shell: true
          }
        }
      },
      {
        ...created.value,
        sourceIdentities: [
          {
            sourceId: "source-1",
            identity: {
              sha256: sha256Base64Url(Buffer.from("changed", "utf8")),
              byteLength: 7
            }
          }
        ]
      }
    ];
    for (const mutated of mutations) {
      expect(
        validateApproval({
          subject: mutated,
          approval: approval.value,
          payload
        }).ok
      ).toBe(false);
    }
  });

  it("invalidates approval after payload mutation", () => {
    const payload = Buffer.from("prepared", "utf8");
    const created = subject(payload);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const approval = approveReviewSubject({
      subject: created.value,
      payload,
      decision: "approve-prepared"
    });
    expect(approval.ok).toBe(true);
    if (!approval.ok) return;
    expect(
      validateApproval({
        subject: created.value,
        approval: approval.value,
        payload: Buffer.from("tampered", "utf8")
      }).ok
    ).toBe(false);
  });

  it("creates diff3-style conflicts that require a fresh approval", () => {
    const merge = createDiff3Merge({
      base: Buffer.from("base\n", "utf8"),
      captured: Buffer.from("captured\n", "utf8"),
      current: Buffer.from("current\n", "utf8")
    });
    expect(merge.conflicted).toBe(true);
    expect(merge.requiresFreshApproval).toBe(true);
    expect(merge.bytes.toString("utf8")).toContain("<<<<<<< CAPTURED");
    const selection = selectSnapshot({
      choice: "editable-merge",
      captured: Buffer.from("captured\n", "utf8"),
      current: Buffer.from("current\n", "utf8"),
      editedMerge: Buffer.from("resolved\n", "utf8")
    });
    expect(selection.ok && selection.value.requiresFreshApproval).toBe(true);
  });
});

