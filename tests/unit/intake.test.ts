import { describe, expect, it } from "vitest";

import { snapshotBytes } from "../../src/intake/intake.js";
import { splitRawLines } from "../../src/segment/segment.js";

describe("raw-byte intake", () => {
  it("detects BOM, mixed newlines, Unicode, and ANSI without normalization", () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("alpha\r\nβeta\n\u001b[31mred\u001b[0m\romega", "utf8")
    ]);

    const artifact = snapshotBytes(bytes, {
      ordinal: 0,
      role: "context",
      kind: "pasted",
      label: "mixed"
    });

    expect(artifact.bytes.equals(bytes)).toBe(true);
    expect(artifact.sha256).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(artifact.hasBom).toBe(true);
    expect(artifact.newlineStyle).toBe("mixed");
    expect(artifact.hasAnsi).toBe(true);
    expect(artifact.utf8).toBe("valid");
    expect(splitRawLines(bytes).map((line) => line.bytes).reduce(
      (combined, line) => Buffer.concat([combined, line]),
      Buffer.alloc(0)
    ).equals(bytes)).toBe(true);
  });

  it("detects invalid UTF-8 explicitly", () => {
    const artifact = snapshotBytes(Buffer.from([0xc3, 0x28]), {
      ordinal: 0,
      role: "context",
      kind: "pasted",
      label: "invalid"
    });

    expect(artifact.utf8).toBe("invalid");
  });

  it("supports a megabyte line without truncation", () => {
    const bytes = Buffer.from("x".repeat(1024 * 1024), "utf8");
    const artifact = snapshotBytes(bytes, {
      ordinal: 0,
      role: "context",
      kind: "pasted",
      label: "large-line"
    });

    expect(artifact.byteLength).toBe(1024 * 1024);
    expect(artifact.completeness).toBe("complete");
    expect(splitRawLines(bytes)).toHaveLength(1);
  });
});

