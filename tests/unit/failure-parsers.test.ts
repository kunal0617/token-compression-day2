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
});

