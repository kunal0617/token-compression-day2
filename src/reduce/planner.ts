import type {
  ArtifactSnapshot,
  PlannedTransform,
  ProtectedRange,
  TransformProposal
} from "../contracts/types.js";
import { deterministicUuid, sha256Base64Url } from "../core/hash.js";
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
  return `[CTXO OMIT r=${transform.reason} c=${transform.sourceCount} b=${transform.byteLength} h=${transform.handle}]\n`;
}

export function planTransforms(
  runId: string,
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
    .map((candidate, index): PlannedTransform => {
      const omitted = artifact.bytes.subarray(
        candidate.startByte,
        candidate.endByte
      );
      const omittedSha256 = sha256Base64Url(omitted);
      const occurrenceId = deterministicUuid(
        `${runId}:${artifact.ordinal}:${index}`
      );
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
      const markerBytes = Buffer.byteLength(transform.marker, "utf8");
      const beneficial =
        transform.omittedByteLength > markerBytes;
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
