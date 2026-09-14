import type {
  ArtifactSnapshot,
  PlannedTransform,
  ProtectedRange,
  TransformProposal
} from "../contracts/types.js";
import { sha256Base64Url, sha256Text } from "../core/hash.js";
import { rangesIntersect } from "../core/ranges.js";
import { createHandle } from "../storage/handles.js";

export interface PlanResult {
  readonly selected: readonly PlannedTransform[];
  readonly rejectedProtected: readonly string[];
  readonly rejectedOverlap: readonly string[];
  readonly rejectedNonBeneficial: readonly string[];
}

function markerFor(transform: {
  reason: string;
  sourceCount: number;
  byteLength: number;
  handle: string;
}): string {
  return `[CTXO OMIT reason=${transform.reason} count=${transform.sourceCount} bytes=${transform.byteLength} handle=${transform.handle}]\n`;
}

export function planTransforms(
  artifact: ArtifactSnapshot,
  proposals: readonly TransformProposal[],
  protectedRanges: readonly ProtectedRange[]
): PlanResult {
  const rejectedProtected: string[] = [];
  const eligible = proposals.filter((candidate) => {
    const intersects = protectedRanges.some((protectedRange) =>
      rangesIntersect(candidate, protectedRange)
    );
    if (intersects) rejectedProtected.push(candidate.proposalId);
    return !intersects && candidate.endByte > candidate.startByte;
  });

  const chosen: TransformProposal[] = [];
  const rejectedOverlap: string[] = [];
  const ranked = [...eligible].sort(
    (left, right) =>
      right.priority - left.priority ||
      right.endByte -
        right.startByte -
        (left.endByte - left.startByte) ||
      left.startByte - right.startByte ||
      left.endByte - right.endByte ||
      left.proposalId.localeCompare(right.proposalId)
  );
  for (const candidate of ranked) {
    if (chosen.some((selected) => rangesIntersect(candidate, selected))) {
      rejectedOverlap.push(candidate.proposalId);
      continue;
    }
    chosen.push(candidate);
  }

  const rejectedNonBeneficial: string[] = [];
  const selected = chosen
    .sort(
      (left, right) =>
        left.startByte - right.startByte ||
        left.endByte - right.endByte ||
        left.proposalId.localeCompare(right.proposalId)
    )
    .map((candidate): PlannedTransform => {
      const omitted = artifact.bytes.subarray(
        candidate.startByte,
        candidate.endByte
      );
      const omittedSha256 = sha256Base64Url(omitted);
      const occurrenceId = `omission-${sha256Text(
        `${artifact.artifactId}:${candidate.startByte}:${candidate.endByte}:${candidate.reason}`
      )}`;
      const handle = createHandle(
        omittedSha256,
        omitted.length,
        occurrenceId
      );
      return {
        ...candidate,
        occurrenceId,
        omittedSha256,
        omittedByteLength: omitted.length,
        handle,
        marker: markerFor({
          reason: candidate.reason,
          sourceCount: candidate.sourceCount,
          byteLength: omitted.length,
          handle
        })
      };
    })
    .filter((transform) => {
      const beneficial =
        transform.omittedByteLength > Buffer.byteLength(transform.marker, "utf8");
      if (!beneficial) rejectedNonBeneficial.push(transform.proposalId);
      return beneficial;
    });

  return {
    selected,
    rejectedProtected: rejectedProtected.sort(),
    rejectedOverlap: rejectedOverlap.sort(),
    rejectedNonBeneficial: rejectedNonBeneficial.sort()
  };
}
