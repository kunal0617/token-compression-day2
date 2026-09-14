import { describe, expect, it } from "vitest";

import { classifyArtifact } from "../../src/classify/classify.js";
import { extractEvidence } from "../../src/evidence/extract.js";
import { snapshotBytes } from "../../src/intake/intake.js";
import { buildProtectedRanges } from "../../src/protect/protect.js";
import { planTransforms } from "../../src/reduce/planner.js";
import { proposeTransforms } from "../../src/reduce/propose.js";
import { segmentArtifact } from "../../src/segment/segment.js";

describe("deterministic reduction planning", () => {
  it("selects the same ordered non-overlapping plan every time", () => {
    const artifact = snapshotBytes(
      Buffer.from(`${"Restored package cache\n".repeat(50)}Build succeeded\n`),
      {
        ordinal: 1,
        role: "context",
        kind: "pasted",
        label: "repetition"
      }
    );
    const proposals = proposeTransforms(
      artifact,
      classifyArtifact(artifact),
      "green"
    );

    const first = planTransforms("run-fixed", artifact, proposals, []);
    const second = planTransforms(
      "run-fixed",
      artifact,
      [...proposals].reverse(),
      []
    );

    expect(first.selected).toEqual(second.selected);
    expect(first.selected.length).toBeGreaterThan(0);
    expect(first.selected[0]?.handle).toMatch(
      /^ctxo:v1:sha256:[A-Za-z0-9_-]{43}:\d+:[A-Za-z0-9._-]+$/
    );
  });

  it("rejects transformations intersecting protected ranges", () => {
    const artifact = snapshotBytes(
      Buffer.from("same\nsame\nsame\nsame\n", "utf8"),
      {
        ordinal: 1,
        role: "context",
        kind: "pasted",
        label: "protected"
      }
    );
    const proposals = proposeTransforms(
      artifact,
      classifyArtifact(artifact),
      "unknown"
    );
    const plan = planTransforms("run-fixed", artifact, proposals, [
      {
        artifactId: artifact.artifactId,
        startByte: 5,
        endByte: 10,
        reasons: ["test"],
        evidenceIds: ["evidence"]
      }
    ]);

    expect(plan.rejectedProtected.length).toBeGreaterThan(0);
    expect(
      plan.selected.every(
        (item) => item.endByte <= 5 || item.startByte >= 10
      )
    ).toBe(true);
  });

  it("abstains for incomplete artifacts and distinct failure templates", () => {
    const incomplete = snapshotBytes(
      Buffer.from("INFO worker-1 ready\n".repeat(10), "utf8"),
      {
        ordinal: 1,
        role: "context",
        kind: "pasted",
        label: "incomplete",
        completeness: "unknown",
        completenessReason: "producer did not attest completeness"
      }
    );
    expect(
      proposeTransforms(incomplete, classifyArtifact(incomplete), "green")
    ).toEqual([]);

    const failures = snapshotBytes(
      Buffer.from(
        [
          "ERROR worker-1 TestAlpha expected 1 actual 2",
          "ERROR worker-2 TestBeta expected 1 actual 3",
          "ERROR worker-3 TestGamma expected 1 actual 4",
          "ERROR worker-4 TestDelta expected 1 actual 5",
          ""
        ].join("\n"),
        "utf8"
      ),
      {
        ordinal: 1,
        role: "context",
        kind: "pasted",
        label: "distinct-failures"
      }
    );
    expect(
      proposeTransforms(failures, classifyArtifact(failures), "red").some(
        (item) => item.reason === "volatile-template"
      )
    ).toBe(false);
  });

  it("does not replace tiny or blank repeats with larger markers", () => {
    for (const text of ["\n".repeat(20), "x\n".repeat(20)]) {
      const artifact = snapshotBytes(Buffer.from(text, "utf8"), {
        ordinal: 1,
        role: "context",
        kind: "pasted",
        label: "tiny"
      });
      const proposals = proposeTransforms(
        artifact,
        classifyArtifact(artifact),
        "unknown"
      );
      const plan = planTransforms("run-fixed", artifact, proposals, []);
      expect(plan.selected).toEqual([]);
      expect(plan.rejectedNonBeneficial.length).toBeGreaterThan(0);
    }
  });

  it("preserves volatile warnings in red and unknown runs", () => {
    const artifact = snapshotBytes(
      Buffer.from(
        [
          "WARN worker-1 request delayed",
          "WARN worker-2 request delayed",
          "WARN worker-3 request delayed",
          "WARN worker-4 request delayed",
          ""
        ].join("\n"),
        "utf8"
      ),
      {
        ordinal: 1,
        role: "context",
        kind: "pasted",
        label: "warnings"
      }
    );
    for (const outcome of ["red", "unknown"] as const) {
      expect(
        proposeTransforms(artifact, classifyArtifact(artifact), outcome).some(
          (item) => item.reason === "volatile-template"
        )
      ).toBe(false);
    }
  });

  it("never transforms complete diff artifacts", () => {
    const artifact = snapshotBytes(
      Buffer.from(
        [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1,1 +1,6 @@",
          ...Array.from(
            { length: 8 },
            () =>
              "+const repeatedChangedSourceLine = 'long enough to otherwise fold';"
          ),
          ""
        ].join("\n"),
        "utf8"
      ),
      {
        ordinal: 1,
        role: "context",
        kind: "pasted",
        label: "change.diff"
      }
    );
    const classification = classifyArtifact(artifact);
    expect(classification.kind).toBe("diff");
    expect(proposeTransforms(artifact, classification, "green")).toEqual([]);
  });

  it("protects embedded diff hunks statefully inside test logs", () => {
    const artifact = snapshotBytes(
      Buffer.from(
        [
          "FAIL tests/example.test.ts",
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1,1 +1,8 @@",
          " Tests: this is unchanged source context, not a runner summary",
          ...Array.from(
            { length: 8 },
            () =>
              "+++successChangedSourceLineThatIsLongEnoughToOtherwiseBeFolded"
          ),
          "Tests: 1 failed",
          "Process exited with code 1",
          ""
        ].join("\n"),
        "utf8"
      ),
      {
        ordinal: 1,
        role: "context",
        kind: "pasted",
        label: "mixed.log"
      }
    );
    const classification = classifyArtifact(artifact);
    expect(classification.kind).toBe("test-log");
    const segments = segmentArtifact(artifact);
    const evidence = extractEvidence(artifact, classification, "red");
    const protectedRanges = buildProtectedRanges(
      artifact,
      evidence,
      segments
    );
    const plan = planTransforms(
      "run-fixed",
      artifact,
      proposeTransforms(artifact, classification, "red"),
      protectedRanges
    );
    expect(
      segments
        .filter((segment) => segment.ordinal >= 1 && segment.ordinal <= 13)
        .every((segment) => segment.kind === "diff")
    ).toBe(true);
    expect(plan.selected).toEqual([]);
  });

  it("does not fold arbitrary differing CI group content", () => {
    const artifact = snapshotBytes(
      Buffer.from(
        [
          "2031-04-05T10:00:00.0000000Z ##[group]Unknown state feed",
          ...Array.from(
            { length: 20 },
            (_, index) =>
              `2031-04-05T10:00:${String(index + 1).padStart(2, "0")}.0000000Z state=${
                index === 10 ? "failed" : "queued"
              } id=item-${index} error=detail-${index}`
          ),
          "2031-04-05T10:01:00.0000000Z ##[endgroup]",
          ""
        ].join("\n"),
        "utf8"
      ),
      {
        ordinal: 1,
        role: "context",
        kind: "pasted",
        label: "unsafe-ci-group.log"
      }
    );
    const proposals = proposeTransforms(
      artifact,
      classifyArtifact(artifact),
      "red"
    );
    expect(
      proposals.some((proposal) => proposal.reason === "ci-wrapper")
    ).toBe(false);
  });

  it("does not treat unknown runner state or build IDs as wrapper metadata", () => {
    const artifact = snapshotBytes(
      Buffer.from(
        [
          "2031-04-05T10:00:00.0000000Z ##[group]Runner Image Provisioner",
          "2031-04-05T10:00:00.0100000Z state=queued build_id=alpha",
          "2031-04-05T10:00:00.0200000Z state=running build_id=beta",
          "2031-04-05T10:00:00.0300000Z state=ready build_id=gamma",
          "2031-04-05T10:00:00.0400000Z ##[endgroup]",
          ""
        ].join("\n"),
        "utf8"
      ),
      {
        ordinal: 1,
        role: "context",
        kind: "pasted",
        label: "runner-state.log"
      }
    );
    expect(
      proposeTransforms(
        artifact,
        classifyArtifact(artifact),
        "unknown"
      ).some((proposal) => proposal.reason === "ci-wrapper")
    ).toBe(false);
  });

  it("does not fold ANSI-wrapped unknown fields inside Run groups", () => {
    const artifact = snapshotBytes(
      Buffer.from(
        [
          "2031-04-05T10:00:00.0000000Z ##[group]Run unknown-state script",
          "2031-04-05T10:00:00.0100000Z \u001b[36;1mstate=queued\u001b[0m",
          "2031-04-05T10:00:00.0200000Z \u001b[36;1mbuild_id=alpha\u001b[0m",
          "2031-04-05T10:00:00.0300000Z \u001b[36;1mstate=running\u001b[0m",
          "2031-04-05T10:00:00.0400000Z ##[endgroup]",
          ""
        ].join("\n"),
        "utf8"
      ),
      {
        ordinal: 1,
        role: "context",
        kind: "pasted",
        label: "ansi-unknown-state.log"
      }
    );
    expect(
      proposeTransforms(
        artifact,
        classifyArtifact(artifact),
        "unknown"
      ).some((proposal) => proposal.reason === "ci-wrapper")
    ).toBe(false);
  });
});
