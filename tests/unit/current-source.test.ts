import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { intakeUtf8File } from "../../src/intake/intake.js";
import { LocalFileCurrentSourcePort } from "../../src/tui/current-source.js";

describe("current source recapture", () => {
  it("reads current file bytes and changes identity after mutation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxo-current-source-"));
    const path = join(directory, "source.ts");
    try {
      writeFileSync(path, "export const value = 1;\n", "utf8");
      const captured = await intakeUtf8File(path, {
        ordinal: 0,
        role: "prompt",
        label: "source.ts"
      });
      expect(captured.ok).toBe(true);
      if (!captured.ok) return;
      const port = new LocalFileCurrentSourcePort([captured.value]);
      const first = port.capture();
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      writeFileSync(path, "export const value = 2;\n", "utf8");
      const second = port.capture();
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.sourceIdentities[0]?.identity.sha256).not.toBe(
        first.value.sourceIdentities[0]?.identity.sha256
      );
      expect(second.value.bytes.toString("utf8")).toContain("value = 2");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
