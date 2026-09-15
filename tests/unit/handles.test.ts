import { describe, expect, it } from "vitest";

import { sha256Base64Url } from "../../src/core/hash.js";
import {
  createHandle,
  parseHandle
} from "../../src/storage/handles.js";

describe("strict retrieval handles", () => {
  it("round-trips a full digest, size, and occurrence ID", () => {
    const digest = sha256Base64Url(Buffer.from("payload", "utf8"));
    const handle = createHandle(digest, 7, `omission-${digest}`);
    const parsed = parseHandle(handle);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({
        digest,
        byteLength: 7,
        occurrenceId: `omission-${digest}`
      });
    }
  });

  it("rejects shortened digests and invalid sizes", () => {
    expect(parseHandle("ctxo:v1:sha256:short:7:occ").ok).toBe(false);
    expect(
      parseHandle(
        "ctxo:v1:sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:0:occ"
      ).ok
    ).toBe(false);
  });
});

