import {
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../../src/main.js";

describe("CLI commands", () => {
  it("prepares, inspects, retrieves, and verifies a committed run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-cli-"));
    const promptPath = join(directory, "prompt.txt");
    const contextPath = join(directory, "context.log");
    const outputPath = join(directory, "prepared.txt");
    const storePath = join(directory, "context.sqlite");
    writeFileSync(promptPath, "Fix the failing test.", "utf8");
    writeFileSync(
      contextPath,
      `${"Restored dependency package alpha\n".repeat(100)}Process exited with code 0\n`,
      "utf8"
    );

    try {
      const stdout: (string | Uint8Array)[] = [];
      const stderr: (string | Uint8Array)[] = [];
      const prepareExit = await runCli(
        [
          "prepare",
          "--prompt-file",
          promptPath,
          "--context",
          contextPath,
          "--store",
          storePath,
          "--output",
          outputPath
        ],
        {
          stdout: (value) => stdout.push(value),
          stderr: (value) => stderr.push(value)
        }
      );
      expect(prepareExit).toBe(0);
      expect(stderr).toEqual([]);
      const prepareResponse = JSON.parse(String(stdout[0])) as {
        runId: string;
        receipt: { handles: string[] };
      };
      expect(readFileSync(outputPath, "utf8")).toContain("[CTXO OMIT");

      const inspectOutput: (string | Uint8Array)[] = [];
      expect(
        await runCli(
          [
            "inspect",
            "--run",
            prepareResponse.runId,
            "--store",
            storePath
          ],
          {
            stdout: (value) => inspectOutput.push(value),
            stderr: () => undefined
          }
        )
      ).toBe(0);
      expect(JSON.parse(String(inspectOutput[0])).readiness).toBe("ready");

      const retrieved: (string | Uint8Array)[] = [];
      expect(
        await runCli(
          [
            "retrieve",
            prepareResponse.receipt.handles[0] as string,
            "--store",
            storePath
          ],
          {
            stdout: (value) => retrieved.push(value),
            stderr: () => undefined
          }
        )
      ).toBe(0);
      expect(Buffer.concat(retrieved.map((value) => Buffer.from(value))).length).toBeGreaterThan(0);

      const verifyOutput: (string | Uint8Array)[] = [];
      expect(
        await runCli(
          [
            "verify",
            "--run",
            prepareResponse.runId,
            "--store",
            storePath
          ],
          {
            stdout: (value) => verifyOutput.push(value),
            stderr: () => undefined
          }
        )
      ).toBe(0);
      expect(JSON.parse(String(verifyOutput[0])).reconstruction).toBe(
        "byte-identical"
      );

      const collisionErrors: (string | Uint8Array)[] = [];
      expect(
        await runCli(
          [
            "prepare",
            "--prompt-file",
            promptPath,
            "--context",
            contextPath,
            "--store",
            storePath,
            "--output",
            storePath
          ],
          {
            stdout: () => undefined,
            stderr: (value) => collisionErrors.push(value)
          }
        )
      ).toBe(2);
      expect(String(collisionErrors[0])).toContain("must not overwrite");

      const postCollisionVerify: (string | Uint8Array)[] = [];
      expect(
        await runCli(
          [
            "verify",
            "--run",
            prepareResponse.runId,
            "--store",
            storePath
          ],
          {
            stdout: (value) => postCollisionVerify.push(value),
            stderr: () => undefined
          }
        )
      ).toBe(0);

      const hardlinkPath = join(directory, "store-hardlink.sqlite");
      linkSync(storePath, hardlinkPath);
      const hardlinkErrors: (string | Uint8Array)[] = [];
      expect(
        await runCli(
          [
            "prepare",
            "--prompt-file",
            promptPath,
            "--context",
            contextPath,
            "--store",
            storePath,
            "--output",
            hardlinkPath
          ],
          {
            stdout: () => undefined,
            stderr: (value) => hardlinkErrors.push(value)
          }
        )
      ).toBe(2);
      expect(String(hardlinkErrors[0])).toContain("aliases");

      const sidecarErrors: (string | Uint8Array)[] = [];
      expect(
        await runCli(
          [
            "prepare",
            "--prompt-file",
            promptPath,
            "--context",
            contextPath,
            "--store",
            storePath,
            "--output",
            `${storePath}-wal`
          ],
          {
            stdout: () => undefined,
            stderr: (value) => sidecarErrors.push(value)
          }
        )
      ).toBe(2);
      expect(String(sidecarErrors[0])).toContain("WAL/SHM");

      const finalVerify: (string | Uint8Array)[] = [];
      expect(
        await runCli(
          [
            "verify",
            "--run",
            prepareResponse.runId,
            "--store",
            storePath
          ],
          {
            stdout: (value) => finalVerify.push(value),
            stderr: () => undefined
          }
        )
      ).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
