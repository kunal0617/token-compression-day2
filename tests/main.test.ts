import { describe, expect, it } from "vitest";

import { HELP, runCli } from "../src/main.js";

describe("CLI scaffold", () => {
  it("prints help without side effects", async () => {
    const stdout: (string | Uint8Array)[] = [];
    const stderr: (string | Uint8Array)[] = [];

    const exitCode = await runCli(["--help"], {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });

    expect(exitCode).toBe(0);
    expect(stdout).toEqual([HELP]);
    expect(stderr).toEqual([]);
  });

  it("fails explicitly for unknown commands", async () => {
    const stderr: (string | Uint8Array)[] = [];

    const exitCode = await runCli(["unexpected"], {
      stdout: () => undefined,
      stderr: (value) => stderr.push(value)
    });

    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain("Unknown command: unexpected");
  });
});
