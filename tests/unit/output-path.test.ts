import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkOutputPathSafety,
  type OutputPathProbe
} from "../../src/main.js";

describe("output path safety", () => {
  it("rejects a dangling symlink aimed at an absent SQLite sidecar", async () => {
    const storePath = resolve("future.sqlite");
    const outputPath = resolve("dangling-output.txt");
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const probe: OutputPathProbe = {
      lstat: async (path) => {
        if (path === outputPath) {
          return {
            dev: 1,
            ino: 2,
            isSymbolicLink: () => true
          };
        }
        throw missing;
      },
      realpath: async () => {
        throw missing;
      },
      stat: async () => {
        throw missing;
      }
    };

    const result = await checkOutputPathSafety(
      storePath,
      outputPath,
      probe
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("symbolic link");
    }
  });
});
