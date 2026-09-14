import { describe, expect, it } from "vitest";

import { classifyArtifact } from "../../src/classify/classify.js";
import {
  analyzeCiLines,
  isRecognizedCiArtifact
} from "../../src/ci/envelope.js";
import { extractEvidence } from "../../src/evidence/extract.js";
import { snapshotBytes } from "../../src/intake/intake.js";

describe("CI envelope analysis", () => {
  it("normalizes timestamps and ANSI for signatures without changing bytes", () => {
    const bytes = Buffer.from(
      [
        "\uFEFF2031-04-05T10:00:00.0000000Z ##[group]Run setup",
        "2031-04-05T10:00:00.0100000Z \u001b[36;1mecho hello\u001b[0m",
        "2031-04-05T10:00:00.0200000Z \u001b[36;1mecho hello\u001b[0m",
        "2031-04-05T10:00:00.0300000Z ##[endgroup]",
        ""
      ].join("\n"),
      "utf8"
    );
    const artifact = snapshotBytes(bytes, {
      ordinal: 1,
      role: "context",
      kind: "pasted",
      label: "ci.log"
    });
    const analysis = analyzeCiLines(artifact);

    expect(isRecognizedCiArtifact(analysis)).toBe(true);
    expect(analysis[1]?.content).toBe("echo hello");
    expect(analysis[1]?.stableSignature).toBe(
      analysis[2]?.stableSignature
    );
    expect(artifact.bytes.equals(bytes)).toBe(true);
    expect(artifact.hasBom).toBe(true);
    expect(artifact.hasAnsi).toBe(true);
  });

  it("does not classify timestamps, clocks, or URLs as source locations", () => {
    const artifact = snapshotBytes(
      Buffer.from(
        [
          "\uFEFF2031-04-05T10:00:00.0000000Z ##[group]Diagnostics",
          "2031-04-05T10:00:00.0100000Z See https://example.invalid/app.ts:443/docs",
          "2031-04-05T10:00:00.0200000Z clock 10:00:00",
          "2031-04-05T10:00:00.0300000Z Working directory /home/runner/work/octo/demo",
          "2031-04-05T10:00:00.0400000Z Version: 9.8.7",
          "2031-04-05T10:00:00.0500000Z ##[error]TypeError: broken at src/app.ts:42:7",
          "2031-04-05T10:00:00.0600000Z ##[endgroup]",
          ""
        ].join("\n"),
        "utf8"
      ),
      {
        ordinal: 1,
        role: "context",
        kind: "pasted",
        label: "ci-diagnostics.log"
      }
    );
    const evidence = extractEvidence(
      artifact,
      classifyArtifact(artifact),
      "red"
    );
    const locations = evidence.filter(
      (item) => item.kind === "source-location"
    );

    expect(locations).toHaveLength(1);
    expect(locations[0]?.textPreview).toContain("src/app.ts:42:7");
    expect(locations[0]?.mandatoryInline).toBe(true);
    expect(
      evidence
        .filter((item) => item.kind === "version")
        .every((item) => !item.mandatoryInline)
    ).toBe(true);
    expect(
      evidence
        .filter(
          (item) =>
            item.kind === "path" &&
            item.textPreview.includes("/home/runner/work")
        )
        .every((item) => !item.mandatoryInline)
    ).toBe(true);
  });

  it("requires a meaningful envelope ratio instead of three prefixed lines", () => {
    const artifact = snapshotBytes(
      Buffer.from(
        [
          "2031-04-05T10:00:00.0000000Z ##[group]setup",
          "2031-04-05T10:00:00.0100000Z wrapper",
          "2031-04-05T10:00:00.0200000Z ##[endgroup]",
          ...Array.from({ length: 102 }, (_, index) => `plain line ${index}`),
          ""
        ].join("\n"),
        "utf8"
      ),
      {
        ordinal: 1,
        role: "context",
        kind: "pasted",
        label: "mostly-plain.log"
      }
    );
    expect(isRecognizedCiArtifact(analyzeCiLines(artifact))).toBe(false);
  });
});
