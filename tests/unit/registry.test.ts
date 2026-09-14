import { describe, expect, it } from "vitest";

import type { VersionedProducer } from "../../src/contracts/providers.js";
import { canonicalJsonDigest } from "../../src/core/canonical.js";
import { builtinRuntime, createBuiltinRuntime } from "../../src/registry/builtins.js";
import {
  compareCanonicalText,
  producerSnapshotMatchesRegistry,
  VersionedRegistry
} from "../../src/registry/registry.js";

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

  it("snapshots and freezes metadata instead of retaining mutable references", () => {
    const registry = new VersionedRegistry<VersionedProducer>();
    const mutable = {
      producerId: "test.mutable",
      kind: "detector" as const,
      version: "1.0.0",
      digest: canonicalJsonDigest("original")
    };
    expect(registry.register({ metadata: mutable }).ok).toBe(true);
    mutable.version = "9.9.9";
    mutable.digest = canonicalJsonDigest("mutated");

    const stored = registry.metadata()[0];
    expect(stored?.version).toBe("1.0.0");
    expect(stored?.digest).toBe(canonicalJsonDigest("original"));
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(registry.metadata())).toBe(true);
  });

  it("uses locale-independent binary ordering", () => {
    expect(compareCanonicalText("B", "a")).toBeLessThan(0);
    const registry = new VersionedRegistry<VersionedProducer>();
    for (const producerId of ["a", "B"]) {
      expect(
        registry.register({
          metadata: {
            producerId,
            kind: "detector",
            version: "1.0.0",
            digest: canonicalJsonDigest(producerId)
          }
        }).ok
      ).toBe(true);
    }
    expect(registry.metadata().map((item) => item.producerId)).toEqual([
      "B",
      "a"
    ]);
  });

  it("keeps an old producer snapshot resolvable after unrelated evolution", () => {
    const registry = new VersionedRegistry<VersionedProducer>();
    const original = {
      producerId: "test.original",
      kind: "detector" as const,
      version: "1.0.0",
      digest: canonicalJsonDigest("original")
    };
    expect(registry.register({ metadata: original }).ok).toBe(true);
    const snapshot = registry.metadata();
    expect(
      registry.register({
        metadata: {
          producerId: "test.unrelated",
          kind: "feature-provider",
          version: "1.0.0",
          digest: canonicalJsonDigest("unrelated")
        }
      }).ok
    ).toBe(true);
    expect(producerSnapshotMatchesRegistry(snapshot, registry)).toBe(true);
    expect(
      registry.register({
        metadata: {
          ...original,
          digest: canonicalJsonDigest("conflict")
        }
      }).ok
    ).toBe(false);
  });
});
