import { describe, expect, it } from "vitest";

import { HELP, runCli } from "../src/main.js";

describe("CLI scaffold", () => {
  it("prints help without side effects", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = runCli(["--help"], {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });

    expect(exitCode).toBe(0);
    expect(stdout).toEqual([HELP]);
    expect(stderr).toEqual([]);
  });

  it("fails explicitly for unknown commands", () => {
    const stderr: string[] = [];

    const exitCode = runCli(["unexpected"], {
      stdout: () => undefined,
      stderr: (value) => stderr.push(value)
    });

    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain("Unknown command: unexpected");
  });
});

