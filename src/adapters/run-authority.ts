import type {
  EvidenceFact,
  EvidenceObligationSpec
} from "../contracts/obligations.js";
import type {
  AgentReadScope,
  AgentRunScopeAuthority,
  ApprovedAgentSendRequest
} from "../contracts/agent.js";
import type { ProducerMetadata } from "../contracts/providers.js";
import type { DeliverySlice } from "../contracts/source-scope.js";
import type { ApprovedReviewPayload } from "../contracts/tui.js";
import type { ArtifactSnapshot } from "../contracts/types.js";
import type { EvidenceSpan } from "../contracts/types.js";
import { validateApproval } from "../approval/review.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import { sha256Base64Url } from "../core/hash.js";
import { agentReadScopeDigest } from "../core/read-scope.js";
import { failure, success, type Result } from "../core/result.js";
import {
  assessFailureEvidence,
  buildFailureObligationSpecs,
  validateEvidenceFact
} from "../obligations/evaluate.js";
import { builtinRuntime } from "../registry/builtins.js";
import { renderContext } from "../render/render.js";
import type { ContextStore } from "../storage/store.js";
import {
  snapshotsFromManifest,
  verifyStoredRun
} from "../validate/validate.js";

function orderedFacts(
  facts: readonly EvidenceFact[]
): EvidenceFact[] {
  return [...facts].sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.factId, "utf8"),
      Buffer.from(right.factId, "utf8")
    )
  );
}

function reviewRequestDigest(input: {
  readonly runId: string;
  readonly approved: Omit<ApprovedReviewPayload, "authorityToken">;
  readonly readScopeDigest: string;
}): string {
  return canonicalJsonDigest({
    runId: input.runId,
    subject: input.approved.subject,
    approval: input.approved.approval,
    payloadSha256: sha256Base64Url(input.approved.bytes),
    payloadByteLength: input.approved.bytes.length,
    readScopeDigest: input.readScopeDigest,
    evidenceFacts: orderedFacts(input.approved.evidenceFacts)
  });
}

export class CommittedRunScopeAuthority
  implements AgentRunScopeAuthority
{
  readonly #store: ContextStore;
  readonly #sources: readonly DeliverySlice[];
  readonly #trustedRetrievalProducers: readonly ProducerMetadata[];

  constructor(
    store: ContextStore,
    sources: readonly DeliverySlice[] = [],
    trustedRetrievalProducers: readonly ProducerMetadata[] = []
  ) {
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
    this.#trustedRetrievalProducers =
      structuredClone(trustedRetrievalProducers);
  }

  #validateScope(
    runId: string,
    scope: AgentReadScope,
    artifacts: readonly ArtifactSnapshot[],
    evidence: readonly EvidenceSpan[]
  ): Result<string> {
    if (scope.runId !== runId) {
      return failure("INTEGRITY_ERROR", "Read scope run ID mismatch");
    }
    const scopeDigest = agentReadScopeDigest(scope);
    if (!scopeDigest.ok) return scopeDigest;
    const artifactsById = new Map(
      artifacts.map((artifact) => [artifact.artifactId, artifact])
    );
    for (const item of scope.evidence) {
      const artifact = artifactsById.get(item.span.artifactId);
      const authoritative = evidence.find(
        (candidate) =>
          candidate.evidenceId === item.span.evidenceId
      );
      if (
        artifact === undefined ||
        authoritative === undefined ||
        canonicalJsonDigest(authoritative) !==
          canonicalJsonDigest(item.span) ||
        !artifact.bytes
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
    return scopeDigest;
  }

  #validateEvidenceCompletion(input: {
    readonly artifacts: readonly ArtifactSnapshot[];
    readonly evidence: readonly EvidenceSpan[];
    readonly approved: Omit<ApprovedReviewPayload, "authorityToken">;
    readonly trustedRetrievalProducers: readonly ProducerMetadata[];
  }): Result<"ready" | "gather-more-evidence"> {
    const facts = orderedFacts(input.approved.evidenceFacts);
    const allSpecs: EvidenceObligationSpec[] = [];
    let decision: "ready" | "gather-more-evidence" = "ready";
    for (const artifact of input.artifacts) {
      if (artifact.role === "prompt") continue;
      const assessed = assessFailureEvidence({
        artifact,
        evidence: input.evidence.filter(
          (item) => item.artifactId === artifact.artifactId
        ),
        additionalFacts: facts,
        trustedRetrievalProducers:
          input.trustedRetrievalProducers
      });
      if (!assessed.ok) return assessed;
      if (
        assessed.value.sufficiency.decision ===
        "gather-more-evidence"
      ) {
        decision = "gather-more-evidence";
      }
      allSpecs.push(
        ...buildFailureObligationSpecs({
          reports: assessed.value.reports,
          evidence: input.evidence.filter(
            (item) => item.artifactId === artifact.artifactId
          )
        })
      );
    }
    for (const fact of facts) {
      const spec = allSpecs.find(
        (candidate) =>
          candidate.obligationId === fact.obligationId
      );
      const evidence = input.evidence.filter(
        (item) => item.artifactId === fact.artifactId
      );
      if (
        fact.origin !== "bounded-retrieval" ||
        spec === undefined ||
        !validateEvidenceFact(
          fact,
          spec,
          evidence,
          input.trustedRetrievalProducers
        )
      ) {
        return failure(
          "INTEGRITY_ERROR",
          "Review evidence fact is not backed by an approved retrieval",
          { factId: fact.factId }
        );
      }
    }
    return success(decision);
  }

  #validateReview(input: {
    readonly runId: string;
    readonly approved: Omit<ApprovedReviewPayload, "authorityToken">;
    readonly readScope: AgentReadScope;
  }): Result<{ readonly requestDigest: string; readonly factsDigest: string }> {
    const verified = verifyStoredRun(this.#store, input.runId);
    if (!verified.ok) return verified;
    const artifactBytes = this.#store.loadArtifactBytes(input.runId);
    if (!artifactBytes.ok) return artifactBytes;
    const artifacts = snapshotsFromManifest(
      verified.value.manifest,
      artifactBytes.value
    );
    if (!artifacts.ok) return artifacts;
    const scopeDigest = this.#validateScope(
      input.runId,
      input.readScope,
      artifacts.value,
      verified.value.manifest.evidence
    );
    if (!scopeDigest.ok) return scopeDigest;
    const approval = validateApproval({
      subject: input.approved.subject,
      approval: input.approved.approval,
      payload: input.approved.bytes
    });
    if (!approval.ok) return approval;
    const manifest = verified.value.manifest;
    const subject = input.approved.subject;
    const expectedSources = manifest.artifacts
      .map((artifact) => ({
        sourceId: artifact.artifactId,
        identity: {
          sha256: artifact.sha256,
          byteLength: artifact.byteLength
        }
      }))
      .sort((left, right) =>
        Buffer.compare(
          Buffer.from(left.sourceId, "utf8"),
          Buffer.from(right.sourceId, "utf8")
        )
      );
    const originalBytes = renderContext(
      artifacts.value,
      new Map<string, readonly never[]>(),
      manifest.evidence
    ).preparedBytes;
    const expectedPayload =
      subject.payloadRole === "prepared"
        ? verified.value.preparedBytes
        : subject.payloadRole === "captured"
          ? originalBytes
          : input.approved.bytes;
    const committedPayloadRole =
      subject.payloadRole === "prepared" ||
      subject.payloadRole === "captured";
    if (
      !expectedPayload.equals(input.approved.bytes) ||
      (committedPayloadRole &&
        canonicalJsonDigest(subject.sourceIdentities) !==
          canonicalJsonDigest(expectedSources)) ||
      manifest.policy === undefined ||
      subject.policyDigest !== canonicalJsonDigest(manifest.policy) ||
      manifest.producerRegistry === undefined ||
      subject.detectorRegistryDigest !==
        manifest.producerRegistry.digest ||
      subject.reviewProducerRegistry.digest !==
        builtinRuntime.reviewRegistryDigest ||
      canonicalJsonDigest(
        subject.reviewProducerRegistry.producers
      ) !== canonicalJsonDigest(builtinRuntime.reviewProducers) ||
      subject.readScopeDigest !== scopeDigest.value ||
      subject.tokenizer !== manifest.tokenizer.encoding
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Review subject does not match the committed run"
      );
    }
    const evidence = this.#validateEvidenceCompletion({
      artifacts: artifacts.value,
      evidence: manifest.evidence,
      approved: input.approved,
      trustedRetrievalProducers:
        this.#trustedRetrievalProducers
    });
    if (
      !evidence.ok ||
      evidence.value !== "ready" ||
      subject.evidenceDecision !== evidence.value
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Review evidence completion is not ready"
      );
    }
    const facts = orderedFacts(input.approved.evidenceFacts);
    const factsDigest = canonicalJsonDigest(facts);
    return success({
      factsDigest,
      requestDigest: reviewRequestDigest({
        runId: input.runId,
        approved: input.approved,
        readScopeDigest: scopeDigest.value
      })
    });
  }

  issueReview(input: {
    readonly runId: string;
    readonly approved: Omit<ApprovedReviewPayload, "authorityToken">;
    readonly readScope: AgentReadScope;
  }): Result<string> {
    const validated = this.#validateReview(input);
    if (!validated.ok) return validated;
    const facts = orderedFacts(input.approved.evidenceFacts);
    const saved = this.#store.saveReviewFacts(input.runId, facts);
    if (!saved.ok) return saved;
    if (
      input.approved.subject.evidenceDecision === "ready" &&
      facts.length > 0
    ) {
      const completed = this.#store.saveEvidenceCompletion(
        input.runId,
        validated.value.factsDigest
      );
      if (!completed.ok) return completed;
    }
    return this.#store.issueReviewAuthority({
      runId: input.runId,
      requestDigest: validated.value.requestDigest,
      payload: input.approved.bytes,
      factsDigest: validated.value.factsDigest
    });
  }

  validate(request: ApprovedAgentSendRequest): Result<void> {
    const approved = {
      bytes: request.approved.bytes,
      subject: request.approved.subject,
      approval: request.approved.approval,
      evidenceFacts: request.approved.evidenceFacts
    };
    const trustedRetrievalProducers = orderedFacts(
      request.approved.evidenceFacts
    ).flatMap((fact) =>
      fact.retrievalBinding === undefined
        ? []
        : [fact.retrievalBinding.adapter]
    );
    const validated = this.#validateReview({
      runId: request.runId,
      approved,
      readScope: request.readScope
    });
    if (!validated.ok) return validated;
    return this.#store.validateReviewAuthority({
      token: request.approved.authorityToken,
      runId: request.runId,
      requestDigest: validated.value.requestDigest,
      payload: request.approved.bytes,
      factsDigest: validated.value.factsDigest
    });
  }
}
