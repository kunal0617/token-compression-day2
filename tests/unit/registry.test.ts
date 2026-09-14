import { describe, expect, it } from "vitest";

import type { VersionedProducer } from "../../src/contracts/providers.js";
import { builtinRuntime, createBuiltinRuntime } from "../../src/registry/builtins.js";
import { VersionedRegistry } from "../../src/registry/registry.js";

describe("versioned producer registry", () => {
  it("is deterministic and records full producer digests", () => {
    const secondRuntime = createBuiltinRuntime();

    expect(builtinRuntime.registryDigest).toBe(secondRuntime.registryDigest);
    expect(builtinRuntime.producers).toEqual(secondRuntime.producers);
    expect(
      builtinRuntime.producers.every((producer) =>
        /^[A-Za-z0-9_-]{43}$/.test(producer.digest)
      )
    ).toBe(true);
  });

  it("rejects duplicate producer IDs", () => {
    const registry = new VersionedRegistry<VersionedProducer>();
    const producer: VersionedProducer = {
      metadata: builtinRuntime.producers[0] as NonNullable<
        (typeof builtinRuntime.producers)[number]
      >
    };

    expect(registry.register(producer).ok).toBe(true);
    expect(registry.register(producer).ok).toBe(false);
  });
});

