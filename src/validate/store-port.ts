import type {
  CanonicalManifest,
  ContextReceipt
} from "../contracts/types.js";
import type { ProducerMetadata } from "../contracts/providers.js";
import type { Result } from "../core/result.js";

export interface ValidationStore {
  getRunState(runId: string): Result<{
    status: "staging" | "committed" | "failed";
    validationStatus: "pending" | "validated" | "failed";
  }>;
  loadManifest(runId: string): Result<{
    manifest: CanonicalManifest;
    manifestJson: string;
    manifestSha256: string;
  }>;
  loadManifestForValidation(runId: string): Result<{
    manifest: CanonicalManifest;
    manifestJson: string;
    manifestSha256: string;
  }>;
  loadPreparedBytes(runId: string): Result<Buffer>;
  loadPreparedBytesForValidation(runId: string): Result<Buffer>;
  loadArtifactBytes(runId: string): Result<ReadonlyMap<string, Buffer>>;
  retrieve(handle: string): Result<Buffer>;
  retrieveForValidation(runId: string, handle: string): Result<Buffer>;
  loadRunProducers(runId: string): Result<readonly ProducerMetadata[]>;
  loadRunProducersForValidation(
    runId: string
  ): Result<readonly ProducerMetadata[]>;
  inspectReceipt(runId: string): Result<ContextReceipt>;
}
