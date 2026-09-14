import { describe, expect, it } from "vitest";

import { snapshotBytes } from "../../src/intake/intake.js";
import {
  conservativeFailureFallbackDetector,
  nodeV8FailureDetector,
  typedFailureParsers,
  vitestJestFailureDetector
} from "../../src/parsers/failures.js";

function artifact(text: string) {
  return snapshotBytes(Buffer.from(text, "utf8"), {
    ordinal: 1,
    role: "context",
    kind: "pasted",
    label: "failure.log"
  });
}

describe("CQ-02 typed failure parsers", () => {
  it("parses Vitest/Jest names, values, command, exit, location, and environment", () => {
    const input = artifact(
      [
        "$ npm test",
        "Vitest 3.2.4",
        "FAIL tests/math.test.ts > math > adds",
        "× math > adds",
        "Expected: 42",
        "Received: 41",
        "  at tests/math.test.ts:10:5",
        "Tests: 1 failed, 3 passed",
        "Process exited with code 1",
        ""
      ].join("\n")
    );
    const result = vitestJestFailureDetector.detect({ artifact: input });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const report = result.value.findings[0];
    expect(report?.parser).toBe("vitest-jest");
    expect(report?.tests[0]).toMatchObject({
      testName: "math > adds",
      expected: "42",
      actual: "41"
    });
    expect(report?.commands[0]).toMatchObject({
      command: "npm test",
      exitCode: 1
    });
    expect(report?.environment).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "Vitest", value: "3.2.4" })
      ])
    );
    expect(report?.exitCode).toBe(1);
    expect(report?.completeness).toBe("complete");
  });

  it("parses Node/V8 exception codes, causes, and frames", () => {
    const input = artifact(
      [
        "$ node app.js",
        "Node.js v22.13.0",
        "TypeError: outer failure",
        "  code: 'ERR_OUTER'",
        "  at run (src/app.ts:20:3)",
        "Caused by: RangeError: inner failure",
        "  at parse (src/input.ts:4:7)",
        "Process exited with code 1",
        ""
      ].join("\n")
    );
    const result = nodeV8FailureDetector.detect({ artifact: input });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const exception = result.value.findings[0]?.exceptions[0];
    expect(exception).toMatchObject({
      type: "TypeError",
      message: "outer failure",
      code: "ERR_OUTER"
    });
    expect(exception?.frames[0]?.location).toEqual({
      path: "src/app.ts",
      line: 20,
      column: 3
    });
    expect(exception?.causes[0]).toMatchObject({
      type: "RangeError",
      message: "inner failure"
    });
    expect(exception?.causes[0]?.frames[0]?.location.path).toBe(
      "src/input.ts"
    );
  });

  it("uses an explicit conservative fallback without claiming recognition", () => {
    const input = artifact("custom runner failure state\nopaque payload\n");
    const reports = typedFailureParsers.parse(input);
    expect(reports.ok).toBe(true);
    if (!reports.ok) return;
    expect(reports.value).toHaveLength(1);
    expect(reports.value[0]).toMatchObject({
      parser: "conservative-fallback",
      recognized: false,
      completeness: "unknown"
    });
    expect(reports.value[0]?.fallbackRanges).toHaveLength(1);

    const direct = conservativeFailureFallbackDetector.detect({
      artifact: input
    });
    expect(direct.ok).toBe(true);
  });

  it("keeps similar failures with changed values as distinct reports", () => {
    const first = typedFailureParsers.parse(
      artifact("TypeError: value 1\n  at run (src/a.ts:1:1)\n")
    );
    const second = typedFailureParsers.parse(
      artifact("TypeError: value 2\n  at run (src/a.ts:1:1)\n")
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value[0]?.exceptions[0]?.message).toBe("value 1");
    expect(second.value[0]?.exceptions[0]?.message).toBe("value 2");
  });

  it("parses bracketed Node error codes and never returns an empty recognized report", () => {
    const parsed = typedFailureParsers.parse(
      artifact(
        "TypeError [ERR_INVALID_ARG_TYPE]: value must be a string\n  at run (src/app.ts:2:3)\n"
      )
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value[0]).toMatchObject({
      parser: "node-v8",
      recognized: true
    });
    expect(parsed.value[0]?.exceptions[0]).toMatchObject({
      type: "TypeError",
      code: "ERR_INVALID_ARG_TYPE",
      message: "value must be a string"
    });

    const fallback = typedFailureParsers.parse(
      artifact("ERR_UNKNOWN_FORMAT without a typed exception line\n")
    );
    expect(fallback.ok).toBe(true);
    if (!fallback.ok) return;
    expect(fallback.value[0]?.recognized).toBe(false);
  });

  it("falls back for summary-only Jest output without a typed failure block", () => {
    const parsed = typedFailureParsers.parse(
      artifact("Jest\nTest Suites: 1 failed, 1 total\nTests: 0 total\n")
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value[0]?.parser).toBe("conservative-fallback");
    expect(parsed.value[0]?.recognized).toBe(false);
    expect(parsed.value[0]?.fallbackRanges.length).toBeGreaterThan(0);
  });

  it("extends Unicode CRLF test ranges through values, stack, and summary", () => {
    const text = [
      "FAIL tests/unicode.test.ts > suite > handles 😀",
      "× suite > handles 😀",
      "Expected: café",
      "Received: cafe",
      "- café",
      "+ cafe",
      "  at tests/unicode.test.ts:12:7",
      "Tests: 1 failed, 2 passed",
      ""
    ].join("\r\n");
    const input = artifact(text);
    const parsed = vitestJestFailureDetector.detect({ artifact: input });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const failure = parsed.value.findings[0]?.tests[0];
    expect(failure).toBeDefined();
    if (failure === undefined) return;
    const bytes = input.bytes.subarray(
      failure.startByte,
      failure.endByte
    );
    expect(bytes.toString("utf8")).toContain("Expected: café\r\n");
    expect(bytes.toString("utf8")).toContain(
      "at tests/unicode.test.ts:12:7\r\n"
    );
    expect(bytes.toString("utf8")).toContain(
      "Tests: 1 failed, 2 passed\r\n"
    );
    expect(failure.location).toEqual({
      path: "tests/unicode.test.ts",
      line: 12,
      column: 7
    });
  });
});
