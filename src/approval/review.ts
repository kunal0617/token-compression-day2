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
  readonly reviewProducerRegistry: {
    readonly digest: string;
    readonly producers: readonly ProducerMetadata[];
  };
  readonly readScopeDigest: string;
  readonly evidenceDecision: "ready" | "gather-more-evidence";
  readonly tokenizer: string;
  readonly target: ApprovalTarget;
  readonly snapshotChoice: SnapshotChoice;
  readonly payloadRole: ReviewSubject["payloadRole"];
  readonly createdAt?: string;
}

export class ReviewSubjectProvider
  implements FeatureProvider<ReviewSubjectInput, ReviewSubject>
{
  readonly metadata = producer(
    "builtin.cq07.review-subject",
    "2.0.0",
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
      "snapshot-choice",
      "payload-role",
      "read-scope",
      "evidence-decision",
      "review-producer-registry"
    ]
  );

  provide(input: ReviewSubjectInput): Result<ReviewSubject> {
    if (
      input.runId.length === 0 ||
      input.sourceIdentities.some(
        (source) =>
          source.sourceId.length === 0 ||
          source.identity.byteLength < 0 ||
          !Number.isSafeInteger(source.identity.byteLength) ||
          !/^[A-Za-z0-9_-]{43}$/.test(source.identity.sha256)
      ) ||
      new Set(input.sourceIdentities.map((source) => source.sourceId))
        .size !== input.sourceIdentities.length ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.policyDigest) ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.detectorRegistryDigest) ||
      input.reviewProducerRegistry.digest !==
        canonicalJsonDigest(input.reviewProducerRegistry.producers) ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.readScopeDigest) ||
      input.tokenizer.length === 0 ||
      input.target.adapterId.length === 0 ||
      input.target.workingDirectory.length === 0 ||
      input.snapshotChoice === "cancel"
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Review subject inputs are invalid or ambiguous"
      );
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const unsigned = {
      reviewSubjectId: deterministicUuid(
        `${input.runId}:${sha256Base64Url(input.payload)}:${createdAt}`
      ),
      runId: input.runId,
      payloadSha256: sha256Base64Url(input.payload),
      payloadByteLength: input.payload.length,
      sourceIdentities: [...input.sourceIdentities].sort((left, right) =>
        Buffer.compare(
          Buffer.from(left.sourceId, "utf8"),
          Buffer.from(right.sourceId, "utf8")
        )
      ),
      policyDigest: input.policyDigest,
      detectorRegistryDigest: input.detectorRegistryDigest,
      reviewProducerRegistry: input.reviewProducerRegistry,
      readScopeDigest: input.readScopeDigest,
      evidenceDecision: input.evidenceDecision,
      tokenizer: input.tokenizer,
      target: input.target,
      snapshotChoice: input.snapshotChoice,
      payloadRole: input.payloadRole,
      createdAt,
      producer: this.metadata
    };
    return success({
      ...unsigned,
      digest: canonicalJsonDigest(unsigned)
    });
  }
}

function decisionMatchesSubject(
  decision: ApprovalDecision,
  subject: ReviewSubject
): boolean {
  return (
    (decision === "approve-prepared" &&
      subject.payloadRole === "prepared" &&
      subject.snapshotChoice === "captured") ||
    (decision === "keep-original" &&
      subject.payloadRole === "captured" &&
      subject.snapshotChoice === "captured") ||
    (decision === "approve-selected" &&
      ((subject.payloadRole === "current" &&
        subject.snapshotChoice === "current") ||
        (subject.payloadRole === "both" &&
          subject.snapshotChoice === "both"))) ||
    (decision === "approve-merged" &&
      subject.payloadRole === "merged" &&
      subject.snapshotChoice === "editable-merge")
  );
}

export function approveReviewSubject(input: {
  readonly subject: ReviewSubject;
  readonly payload: Buffer;
  readonly decision: ApprovalDecision;
  readonly approvedAt?: string;
}): Result<ApprovalRecord> {
  if (input.subject.evidenceDecision !== "ready") {
    return failure(
      "INVALID_ARGUMENT",
      "Gather More Evidence must complete before approval"
    );
  }
  if (input.decision === "reject") {
    return failure("INVALID_ARGUMENT", "Rejected review subjects are not approvals");
  }
  if (!decisionMatchesSubject(input.decision, input.subject)) {
    return failure(
      "INVALID_ARGUMENT",
      "Approval decision does not match selected payload role and snapshot"
    );
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
    reviewProducerRegistry: subject.reviewProducerRegistry,
    readScopeDigest: subject.readScopeDigest,
    evidenceDecision: subject.evidenceDecision,
    tokenizer: subject.tokenizer,
    target: subject.target,
    snapshotChoice: subject.snapshotChoice,
    payloadRole: subject.payloadRole,
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
    !decisionMatchesSubject(approval.decision, subject) ||
    canonicalJsonDigest(subject.producer) !==
      canonicalJsonDigest(reviewSubjectProvider.metadata) ||
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
