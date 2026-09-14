import { describe, expect, it } from "vitest";

import {
  classifyArtifact,
  classifyIntent,
  determineOutcome
} from "../../src/classify/classify.js";
import { snapshotBytes } from "../../src/intake/intake.js";
import { planTransforms } from "../../src/reduce/planner.js";
import { proposeTransforms } from "../../src/reduce/propose.js";

function artifact(text: string) {
  return snapshotBytes(Buffer.from(text, "utf8"), {
    ordinal: 1,
    role: "context",
    kind: "pasted",
    label: "classification"
  });
}

describe("deterministic classification and outcome precedence", () => {
  it("uses structured exit code ahead of misleading summaries", () => {
    expect(
      determineOutcome([
        artifact("All tests passed\nFAIL late failure\nProcess exited with code 1\n")
      ])
    ).toBe("red");
    expect(
      determineOutcome([
        artifact("Tests: 1 failed\nProcess exited with code 0\n")
      ])
    ).toBe("green");
  });

  it("reports reasons and uncertainty", () => {
    const unknown = artifact("plain prose with no parser signature");
    const classification = classifyArtifact(unknown);
    const prompt = snapshotBytes(Buffer.from("Please help with this.", "utf8"), {
      ordinal: 0,
      role: "prompt",
      kind: "pasted",
      label: "prompt"
    });

    expect(classification.uncertain).toBe(true);
    expect(classification.reasons.length).toBeGreaterThan(0);
    expect(classifyIntent(prompt).uncertain).toBe(true);
  });

  it("discovers green volatile templates but preserves values in retrieval", () => {
    const log = artifact(
      [
        "INFO 2026-09-14T09:00:00Z worker-1 request 6ba7b810-9dad-11d1-80b4-00c04fd430c8 completed in 30ms",
        "INFO 2026-09-14T09:00:01Z worker-2 request 6ba7b811-9dad-11d1-80b4-00c04fd430c8 completed in 31ms",
        "INFO 2026-09-14T09:00:02Z worker-3 request 6ba7b812-9dad-11d1-80b4-00c04fd430c8 completed in 32ms",
        "INFO 2026-09-14T09:00:03Z worker-4 request 6ba7b813-9dad-11d1-80b4-00c04fd430c8 completed in 33ms",
        ""
      ].join("\n")
    );

    const proposals = proposeTransforms(log, classifyArtifact(log), "green");
    expect(
      proposals.some((proposal) => proposal.reason === "volatile-template")
    ).toBe(true);
    expect(
      planTransforms(log, proposals, []).selected.some(
        (proposal) => proposal.reason === "volatile-template"
      )
    ).toBe(true);
  });

  it("does not apply scoped boilerplate rules to near misses", () => {
    const log = artifact(
      [
        "INFO application notice: keep this",
        "INFO application notice: keep that",
        "INFO application notice: keep everything",
        ""
      ].join("\n")
    );
    expect(
      proposeTransforms(log, classifyArtifact(log), "unknown").some(
        (proposal) => proposal.reason === "scoped-boilerplate"
      )
    ).toBe(false);
  });
});
