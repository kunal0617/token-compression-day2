import type {
  ProducerMetadata,
  VersionedProducer
} from "../contracts/providers.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import { failure, success, type Result } from "../core/result.js";

export function compareCanonicalText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function compareProducerMetadata(
  left: ProducerMetadata,
  right: ProducerMetadata
): number {
  return (
    compareCanonicalText(left.producerId, right.producerId) ||
    compareCanonicalText(left.version, right.version) ||
    compareCanonicalText(left.digest, right.digest)
  );
}

function snapshotMetadata(metadata: ProducerMetadata): ProducerMetadata {
  if (
    !/^[A-Za-z0-9._-]+$/.test(metadata.producerId) ||
    metadata.version.length === 0 ||
    !/^[A-Za-z0-9_-]{43}$/.test(metadata.digest)
  ) {
    throw new TypeError("Producer metadata is invalid");
  }
  return Object.freeze({
    producerId: metadata.producerId,
    kind: metadata.kind,
    version: metadata.version,
    digest: metadata.digest
  });
}

function producerKey(metadata: ProducerMetadata): string {
  return `${metadata.producerId}\u0000${metadata.version}\u0000${metadata.digest}`;
}

export class VersionedRegistry<T extends VersionedProducer> {
  readonly #items = new Map<string, T>();

  register(item: T): Result<void> {
    let metadata: ProducerMetadata;
    try {
      metadata = snapshotMetadata(item.metadata);
    } catch (error) {
      return failure("INVALID_ARGUMENT", "Producer metadata is invalid", {
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    const key = producerKey(metadata);
    if (this.#items.has(key)) {
      return failure("INVALID_ARGUMENT", "Producer is already registered", {
        producerId: metadata.producerId,
        version: metadata.version,
        digest: metadata.digest
      });
    }
    const versionConflict = [...this.#items.values()].some(
      (registered) =>
        registered.metadata.producerId === metadata.producerId &&
        registered.metadata.version === metadata.version &&
        registered.metadata.digest !== metadata.digest
    );
    if (versionConflict) {
      return failure(
        "INVALID_ARGUMENT",
        "Producer ID and version already have a different digest",
        { producerId: metadata.producerId, version: metadata.version }
      );
    }
    const snapshot = Object.assign(
      Object.create(Object.getPrototypeOf(item)) as T,
      item,
      { metadata }
    );
    Object.freeze(snapshot);
    this.#items.set(key, snapshot);
    return success(undefined);
  }

  get(
    producerId: string,
    version?: string,
    digest?: string
  ): T | undefined {
    const candidates = [...this.#items.values()]
      .filter(
        (item) =>
          item.metadata.producerId === producerId &&
          (version === undefined || item.metadata.version === version) &&
          (digest === undefined || item.metadata.digest === digest)
      )
      .sort((left, right) =>
        compareProducerMetadata(left.metadata, right.metadata)
      );
    return candidates.at(-1);
  }

  list(): readonly T[] {
    return [...this.#items.values()].sort((left, right) =>
      compareProducerMetadata(left.metadata, right.metadata)
    );
  }

  metadata(): readonly ProducerMetadata[] {
    return Object.freeze(
      this.list().map((item) => snapshotMetadata(item.metadata))
    );
  }

  digest(): string {
    return canonicalJsonDigest(this.metadata());
  }
}

export function producerSnapshotMatchesRegistry(
  producers: readonly ProducerMetadata[],
  registry: VersionedRegistry<VersionedProducer>
): boolean {
  const ordered = [...producers].sort(compareProducerMetadata);
  if (
    ordered.some(
      (producer, index) =>
        index > 0 &&
        compareProducerMetadata(ordered[index - 1] as ProducerMetadata, producer) ===
          0
    )
  ) {
    return false;
  }
  return ordered.every(
    (producer) =>
      registry.get(
        producer.producerId,
        producer.version,
        producer.digest
      ) !== undefined
  );
}
