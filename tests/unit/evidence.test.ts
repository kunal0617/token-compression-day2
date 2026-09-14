import { describe, expect, it } from "vitest";

import {
  classifyArtifact,
  determineOutcome
} from "../../src/classify/classify.js";
import { extractEvidence } from "../../src/evidence/extract.js";
import { snapshotBytes } from "../../src/intake/intake.js";

describe("occurrence-specific evidence", () => {
  it("assigns duplicate payload occurrences distinct full identities", () => {
    const artifact = snapshotBytes(
      Buffer.from(
        [
          "$ npm test",
          "Error: repeated failure",
          "  at first (src/a.ts:1:2)",
          "Error: repeated failure",
          "  at second (src/b.ts:3:4)",
          "Process exited with code 1",
          ""
        ].join("\n"),
        "utf8"
      ),
      {
        ordinal: 1,
        role: "context",
        kind: "pasted",
        label: "duplicate-errors"
      }
    );
    const evidence = extractEvidence(
      artifact,
      classifyArtifact(artifact),
      determineOutcome([artifact])
    );
    const duplicateErrors = evidence.filter(
      (item) =>
        item.kind === "exception" &&
        item.textPreview.includes("repeated failure")
    );

    expect(duplicateErrors).toHaveLength(2);
    expect(new Set(duplicateErrors.map((item) => item.evidenceId)).size).toBe(2);
    expect(new Set(duplicateErrors.map((item) => item.occurrenceId)).size).toBe(
      2
    );
    expect(duplicateErrors.every((item) => item.mandatoryInline)).toBe(true);
    expect(duplicateErrors[0]?.sha256).toBe(duplicateErrors[1]?.sha256);
  });

  it("keeps expected and actual values as separate protected facts", () => {
    const artifact = snapshotBytes(
      Buffer.from(
        "AssertionError: values differ\nExpected: 10\nActual: 11\n",
        "utf8"
      ),
      {
        ordinal: 1,
        role: "context",
        kind: "pasted",
        label: "assertion"
      }
    );
    const evidence = extractEvidence(
      artifact,
      classifyArtifact(artifact),
      "red"
    );

    expect(evidence.some((item) => item.kind === "assertion-block")).toBe(true);
    expect(evidence.some((item) => item.kind === "expected-value")).toBe(true);
    expect(evidence.some((item) => item.kind === "actual-value")).toBe(true);
  });
});

