import type {
  AgentReadScope,
  AgentRunScopeAuthority
} from "../contracts/agent.js";
import type { DeliverySlice } from "../contracts/source-scope.js";
import { agentReadScopeDigest } from "../core/read-scope.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import { sha256Base64Url } from "../core/hash.js";
import { failure, success, type Result } from "../core/result.js";
import type { ContextStore } from "../storage/store.js";
import { verifyStoredRun } from "../validate/validate.js";

export class CommittedRunScopeAuthority
  implements AgentRunScopeAuthority
{
  readonly #store: ContextStore;
  readonly #sources: readonly DeliverySlice[];

  constructor(store: ContextStore, sources: readonly DeliverySlice[] = []) {
    this.#store = store;
    this.#sources = sources.map((source) => ({
      ...structuredClone({
        sourceId: source.sourceId,
        path: source.path,
        startByte: source.startByte,
        endByte: source.endByte,
        sha256: source.sha256,
        unitIds: source.unitIds
      }),
      bytes: Buffer.from(source.bytes)
    }));
  }

  validate(runId: string, scope: AgentReadScope): Result<void> {
    if (scope.runId !== runId) {
      return failure("INTEGRITY_ERROR", "Read scope run ID mismatch");
    }
    const scopeDigest = agentReadScopeDigest(scope);
    if (!scopeDigest.ok) return scopeDigest;
    const verified = verifyStoredRun(this.#store, runId);
    if (!verified.ok) return verified;
    const artifactBytes = this.#store.loadArtifactBytes(runId);
    if (!artifactBytes.ok) return artifactBytes;
    for (const item of scope.evidence) {
      const manifestEvidence = verified.value.manifest.evidence.find(
        (evidence) => evidence.evidenceId === item.span.evidenceId
      );
      const bytes = artifactBytes.value.get(item.span.artifactId);
      if (
        manifestEvidence === undefined ||
        bytes === undefined ||
        canonicalJsonDigest(manifestEvidence) !==
          canonicalJsonDigest(item.span) ||
        !bytes
          .subarray(item.span.startByte, item.span.endByte)
          .equals(item.bytes)
      ) {
        return failure(
          "INTEGRITY_ERROR",
          "Evidence read scope is not backed by the committed run",
          { evidenceId: item.span.evidenceId }
        );
      }
    }
    for (const source of scope.sources) {
      const approved = this.#sources.find(
        (item) =>
          item.sourceId === source.sourceId &&
          item.path === source.path &&
          item.startByte === source.startByte &&
          item.endByte === source.endByte &&
          item.sha256 === source.sha256 &&
          canonicalJsonDigest(item.unitIds) ===
            canonicalJsonDigest(source.unitIds)
      );
      if (
        approved === undefined ||
        !approved.bytes.equals(source.bytes) ||
        sha256Base64Url(source.bytes) !== source.sha256
      ) {
        return failure(
          "INTEGRITY_ERROR",
          "Source read scope is not an approved delivery slice",
          { sourceId: source.sourceId }
        );
      }
    }
    return success(undefined);
  }
}
