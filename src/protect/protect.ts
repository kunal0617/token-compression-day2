import type {
  ArtifactSnapshot,
  EvidenceSpan,
  ProtectedRange,
  Segment
} from "../contracts/types.js";

interface MutableProtectedRange {
  startByte: number;
  endByte: number;
  reasons: Set<string>;
  evidenceIds: Set<string>;
}

export interface ProtectionOptions {
  readonly nearbySegments?: number;
  readonly maxCorrelationOccurrences?: number;
}

function mergeProtected(
  artifactId: string,
  ranges: readonly MutableProtectedRange[]
): ProtectedRange[] {
  const ordered = [...ranges].sort(
    (left, right) =>
      left.startByte - right.startByte || left.endByte - right.endByte
  );
  const merged: MutableProtectedRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous === undefined || range.startByte > previous.endByte) {
      merged.push({
        startByte: range.startByte,
        endByte: range.endByte,
        reasons: new Set(range.reasons),
        evidenceIds: new Set(range.evidenceIds)
      });
      continue;
    }
    previous.endByte = Math.max(previous.endByte, range.endByte);
    for (const reason of range.reasons) previous.reasons.add(reason);
    for (const evidenceId of range.evidenceIds) {
      previous.evidenceIds.add(evidenceId);
    }
  }

  return merged.map((range) => ({
    artifactId,
    startByte: range.startByte,
    endByte: range.endByte,
    reasons: [...range.reasons].sort(),
    evidenceIds: [...range.evidenceIds].sort()
  }));
}

export function buildProtectedRanges(
  artifact: ArtifactSnapshot,
  evidence: readonly EvidenceSpan[],
  segments: readonly Segment[],
  options: ProtectionOptions = {}
): ProtectedRange[] {
  if (artifact.role === "prompt") {
    return [
      {
        artifactId: artifact.artifactId,
        startByte: 0,
        endByte: artifact.byteLength,
        reasons: ["mandatory-inline-prompt"],
        evidenceIds: evidence.map((item) => item.evidenceId)
      }
    ];
  }

  const nearby = options.nearbySegments ?? 1;
  const ranges: MutableProtectedRange[] = [];
  for (const item of evidence.filter((candidate) => candidate.mandatoryInline)) {
    const containingOrdinals = segments
      .filter(
        (segment) =>
          segment.startByte < item.endByte && item.startByte < segment.endByte
      )
      .map((segment) => segment.ordinal);
    const first = Math.max(0, Math.min(...containingOrdinals) - nearby);
    const last = Math.min(
      Math.max(0, segments.length - 1),
      Math.max(...containingOrdinals) + nearby
    );
    const firstSegment = segments[first];
    const lastSegment = segments[last];
    ranges.push({
      startByte: firstSegment?.startByte ?? item.startByte,
      endByte: lastSegment?.endByte ?? item.endByte,
      reasons: new Set(["evidence", ...item.protectionReasons]),
      evidenceIds: new Set([item.evidenceId])
    });
  }

  const maxCorrelation = options.maxCorrelationOccurrences ?? 8;
  for (const correlation of evidence.filter(
    (item) => item.kind === "correlation-id"
  )) {
    const token = artifact.bytes
      .subarray(correlation.startByte, correlation.endByte)
      .toString("utf8");
    if (token.length < 4) continue;
    let found = 0;
    for (const segment of segments) {
      if (found >= maxCorrelation) break;
      const text = artifact.bytes
        .subarray(segment.startByte, segment.endByte)
        .toString("utf8");
      if (!text.includes(token)) continue;
      found += 1;
      ranges.push({
        startByte: segment.startByte,
        endByte: segment.endByte,
        reasons: new Set(["bounded-correlation-context"]),
        evidenceIds: new Set([correlation.evidenceId])
      });
    }
  }

  return mergeProtected(artifact.artifactId, ranges);
}
