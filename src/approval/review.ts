import type {
  ApprovalDecision,
  ApprovalRecord,
  ApprovalTarget,
  Diff3MergeResult,
  ReviewSubject,
  SnapshotChoice,
  SnapshotComparison,
  SnapshotSelection
} from "../contracts/approval.js";
import type {
  FeatureProvider,
  ProducerMetadata
} from "../contracts/providers.js";
import type { SourceSnapshotIdentity } from "../contracts/provenance.js";
import { canonicalJson, canonicalJsonDigest } from "../core/canonical.js";
import {
  deterministicUuid,
  sha256Base64Url
} from "../core/hash.js";
import { failure, success, type Result } from "../core/result.js";

function producer(
  producerId: string,
  version: string,
  contract: unknown
): ProducerMetadata {
  return {
    producerId,
    kind: "feature-provider",
    version,
    digest: canonicalJsonDigest({ producerId, version, contract })
  };
}

function snapshotIdentity(bytes: Buffer): SourceSnapshotIdentity {
  return { sha256: sha256Base64Url(bytes), byteLength: bytes.length };
}

export function compareSnapshots(
  captured: Buffer,
  current: Buffer
): SnapshotComparison {
  const capturedIdentity = snapshotIdentity(captured);
  const currentIdentity = snapshotIdentity(current);
  return {
    state:
      capturedIdentity.sha256 === currentIdentity.sha256 &&
      capturedIdentity.byteLength === currentIdentity.byteLength
        ? "unchanged"
        : "changed",
    captured: capturedIdentity,
    current: currentIdentity
  };
}

export function selectSnapshot(input: {
  readonly choice: SnapshotChoice;
  readonly captured: Buffer;
  readonly current: Buffer;
  readonly editedMerge?: Buffer;
}): Result<SnapshotSelection> {
  let bytes: Buffer;
  if (input.choice === "cancel") {
    return failure("INVALID_ARGUMENT", "Snapshot selection was cancelled");
  }
  if (input.choice === "captured") {
    bytes = input.captured;
  } else if (input.choice === "current") {
    bytes = input.current;
  } else if (input.choice === "both") {
    bytes = Buffer.concat([
      Buffer.from("[CAPTURED]\n", "utf8"),
      input.captured,
      Buffer.from("\n[CURRENT]\n", "utf8"),
      input.current
    ]);
  } else {
    if (input.editedMerge === undefined) {
      return failure(
        "INVALID_ARGUMENT",
        "Editable merge selection requires edited bytes"
      );
    }
    bytes = input.editedMerge;
  }
  return success({
    choice: input.choice,
    bytes: Buffer.from(bytes),
    sha256: sha256Base64Url(bytes),
    requiresFreshApproval: input.choice === "editable-merge"
  });
}

export function createDiff3Merge(input: {
  readonly base: Buffer;
  readonly captured: Buffer;
  readonly current: Buffer;
}): Diff3MergeResult {
  if (input.captured.equals(input.current)) {
    return {
      bytes: Buffer.from(input.captured),
      conflicted: false,
      requiresFreshApproval: true
    };
  }
  if (input.base.equals(input.current)) {
    return {
      bytes: Buffer.from(input.captured),
      conflicted: false,
      requiresFreshApproval: true
    };
  }
  if (input.base.equals(input.captured)) {
    return {
      bytes: Buffer.from(input.current),
      conflicted: false,
      requiresFreshApproval: true
    };
  }
  return {
    bytes: Buffer.concat([
      Buffer.from("<<<<<<< CAPTURED\n", "utf8"),
      input.captured,
      Buffer.from("\n||||||| BASE\n", "utf8"),
      input.base,
      Buffer.from("\n=======\n", "utf8"),
      input.current,
      Buffer.from("\n>>>>>>> CURRENT\n", "utf8")
    ]),
    conflicted: true,
    requiresFreshApproval: true
  };
}

export interface ReviewSubjectInput {
  readonly runId: string;
  readonly payload: Buffer;
  readonly sourceIdentities: readonly {
    readonly sourceId: string;
    readonly identity: SourceSnapshotIdentity;
  }[];
  readonly policyDigest: string;
  readonly detectorRegistryDigest: string;
  readonly tokenizer: string;
  readonly target: ApprovalTarget;
  readonly snapshotChoice: SnapshotChoice;
  readonly createdAt?: string;
}

export class ReviewSubjectProvider
  implements FeatureProvider<ReviewSubjectInput, ReviewSubject>
{
  readonly metadata = producer(
    "builtin.cq07.review-subject",
    "1.0.0",
    [
      "payload",
      "sources",
      "policy",
      "detectors",
      "tokenizer",
      "adapter",
      "session",
      "model",
      "cwd",
      "permissions",
      "snapshot-choice"
    ]
  );

  provide(input: ReviewSubjectInput): Result<ReviewSubject> {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const unsigned = {
      reviewSubjectId: deterministicUuid(
        `${input.runId}:${sha256Base64Url(input.payload)}:${createdAt}`
      ),
      runId: input.runId,
      payloadSha256: sha256Base64Url(input.payload),
      payloadByteLength: input.payload.length,
      sourceIdentities: [...input.sourceIdentities].sort((left, right) =>
        left.sourceId.localeCompare(right.sourceId)
      ),
      policyDigest: input.policyDigest,
      detectorRegistryDigest: input.detectorRegistryDigest,
      tokenizer: input.tokenizer,
      target: input.target,
      snapshotChoice: input.snapshotChoice,
      createdAt,
      producer: this.metadata
    };
    return success({
      ...unsigned,
      digest: canonicalJsonDigest(unsigned)
    });
  }
}

export function approveReviewSubject(input: {
  readonly subject: ReviewSubject;
  readonly payload: Buffer;
  readonly decision: ApprovalDecision;
  readonly approvedAt?: string;
}): Result<ApprovalRecord> {
  if (input.decision === "reject") {
    return failure("INVALID_ARGUMENT", "Rejected review subjects are not approvals");
  }
  if (
    input.payload.length !== input.subject.payloadByteLength ||
    sha256Base64Url(input.payload) !== input.subject.payloadSha256
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Approval payload does not match the review subject"
    );
  }
  const approvedAt = input.approvedAt ?? new Date().toISOString();
  const unsigned = {
    approvalId: deterministicUuid(
      `${input.subject.digest}:${input.decision}:${approvedAt}`
    ),
    runId: input.subject.runId,
    reviewSubjectDigest: input.subject.digest,
    approvedPayloadSha256: input.subject.payloadSha256,
    decision: input.decision,
    approvedAt
  };
  return success({ ...unsigned, digest: canonicalJsonDigest(unsigned) });
}

export function validateApproval(input: {
  readonly subject: ReviewSubject;
  readonly approval: ApprovalRecord;
  readonly payload: Buffer;
}): Result<void> {
  const { subject, approval, payload } = input;
  const subjectWithoutDigest = {
    reviewSubjectId: subject.reviewSubjectId,
    runId: subject.runId,
    payloadSha256: subject.payloadSha256,
    payloadByteLength: subject.payloadByteLength,
    sourceIdentities: subject.sourceIdentities,
    policyDigest: subject.policyDigest,
    detectorRegistryDigest: subject.detectorRegistryDigest,
    tokenizer: subject.tokenizer,
    target: subject.target,
    snapshotChoice: subject.snapshotChoice,
    createdAt: subject.createdAt,
    producer: subject.producer
  };
  const approvalWithoutDigest = {
    approvalId: approval.approvalId,
    runId: approval.runId,
    reviewSubjectDigest: approval.reviewSubjectDigest,
    approvedPayloadSha256: approval.approvedPayloadSha256,
    decision: approval.decision,
    approvedAt: approval.approvedAt
  };
  if (
    subject.digest !== canonicalJsonDigest(subjectWithoutDigest) ||
    approval.digest !== canonicalJsonDigest(approvalWithoutDigest) ||
    approval.runId !== subject.runId ||
    approval.reviewSubjectDigest !== subject.digest ||
    approval.approvedPayloadSha256 !== subject.payloadSha256 ||
    payload.length !== subject.payloadByteLength ||
    sha256Base64Url(payload) !== subject.payloadSha256
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Approval is stale or does not bind the current review subject"
    );
  }
  return success(undefined);
}

export function reviewSubjectCanonicalJson(subject: ReviewSubject): string {
  return canonicalJson(subject);
}

export const reviewSubjectProvider = new ReviewSubjectProvider();

