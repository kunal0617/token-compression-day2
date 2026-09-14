import type {
  ProducerMetadata,
  VersionedProducer
} from "../contracts/providers.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import { failure, success, type Result } from "../core/result.js";

export class VersionedRegistry<T extends VersionedProducer> {
  readonly #items = new Map<string, T>();

  register(item: T): Result<void> {
    if (this.#items.has(item.metadata.producerId)) {
      return failure("INVALID_ARGUMENT", "Producer is already registered", {
        producerId: item.metadata.producerId
      });
    }
    this.#items.set(item.metadata.producerId, item);
    return success(undefined);
  }

  get(producerId: string): T | undefined {
    return this.#items.get(producerId);
  }

  list(): readonly T[] {
    return [...this.#items.values()].sort((left, right) =>
      left.metadata.producerId.localeCompare(right.metadata.producerId)
    );
  }

  metadata(): readonly ProducerMetadata[] {
    return this.list().map((item) => item.metadata);
  }

  digest(): string {
    return canonicalJsonDigest(this.metadata());
  }
}

