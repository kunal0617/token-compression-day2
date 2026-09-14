import { describe, expect, it } from "vitest";

import { classifyArtifact } from "../../src/classify/classify.js";
import { snapshotBytes } from "../../src/intake/intake.js";
import { planTransforms } from "../../src/reduce/planner.js";
import { proposeTransforms } from "../../src/reduce/propose.js";

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

    const first = planTransforms(artifact, proposals, []);
    const second = planTransforms(
      artifact,
      [...proposals].reverse(),
      []
    );

    expect(first.selected).toEqual(second.selected);
    expect(first.selected.length).toBeGreaterThan(0);
    expect(first.selected[0]?.handle).toMatch(
      /^ctxo:v1:sha256:[A-Za-z0-9_-]{43}:\d+:omission-[A-Za-z0-9_-]{43}$/
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
    const plan = planTransforms(artifact, proposals, [
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
      const plan = planTransforms(artifact, proposals, []);
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
});
