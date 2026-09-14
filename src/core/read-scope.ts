import type { AgentReadScope } from "../contracts/agent.js";
import { canonicalJsonDigest } from "./canonical.js";
import { sha256Base64Url } from "./hash.js";
import { failure, success, type Result } from "./result.js";

export function agentReadScopeDigest(
  scope: AgentReadScope
): Result<string> {
  const evidenceIds = new Set<string>();
  const occurrenceIds = new Set<string>();
  const sourceKeys = new Set<string>();
  const evidence = [];
  for (const item of scope.evidence) {
    if (
      evidenceIds.has(item.span.evidenceId) ||
      occurrenceIds.has(item.span.occurrenceId) ||
      !Number.isSafeInteger(item.span.startByte) ||
      !Number.isSafeInteger(item.span.endByte) ||
      item.span.startByte < 0 ||
      item.span.endByte <= item.span.startByte ||
      item.bytes.length !== item.span.endByte - item.span.startByte ||
      sha256Base64Url(item.bytes) !== item.span.sha256
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Agent evidence read scope is invalid",
        { evidenceId: item.span.evidenceId }
      );
    }
    evidenceIds.add(item.span.evidenceId);
    occurrenceIds.add(item.span.occurrenceId);
    evidence.push({
      evidenceId: item.span.evidenceId,
      occurrenceId: item.span.occurrenceId,
      artifactId: item.span.artifactId,
      startByte: item.span.startByte,
      endByte: item.span.endByte,
      sha256: item.span.sha256
    });
  }
  const sources = [];
  for (const source of scope.sources) {
    const key = `${source.sourceId}:${source.startByte}:${source.endByte}`;
    if (
      sourceKeys.has(key) ||
      !Number.isSafeInteger(source.startByte) ||
      !Number.isSafeInteger(source.endByte) ||
      source.startByte < 0 ||
      source.endByte <= source.startByte ||
      source.sourceId.length === 0 ||
      source.bytes.length !== source.endByte - source.startByte ||
      sha256Base64Url(source.bytes) !== source.sha256
    ) {
      return failure("INTEGRITY_ERROR", "Agent source read scope is invalid", {
        sourceId: source.sourceId,
        startByte: source.startByte,
        endByte: source.endByte
      });
    }
    sourceKeys.add(key);
    sources.push({
      sourceId: source.sourceId,
      path: source.path,
      startByte: source.startByte,
      endByte: source.endByte,
      sha256: source.sha256,
      unitIds: source.unitIds
    });
  }
  evidence.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.evidenceId, "utf8"),
      Buffer.from(right.evidenceId, "utf8")
    )
  );
  sources.sort(
    (left, right) =>
      Buffer.compare(
        Buffer.from(left.sourceId, "utf8"),
        Buffer.from(right.sourceId, "utf8")
      ) ||
      left.startByte - right.startByte ||
      left.endByte - right.endByte
  );
  return success(
    canonicalJsonDigest({
      runId: scope.runId,
      evidence,
      sources
    })
  );
}
