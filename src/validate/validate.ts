import { canonicalManifestSchema } from "../contracts/schemas.js";
import type {
  ArtifactSnapshot,
  CanonicalManifest,
  ContextPackage,
  EvidenceSpan,
  OutputMapping,
  ValidatedContextPackage
} from "../contracts/types.js";
import { canonicalJson } from "../core/canonical.js";
import { sha256Base64Url } from "../core/hash.js";
import { assertRange, rangesIntersect } from "../core/ranges.js";
import { failure, success, type Result } from "../core/result.js";
import { buildProtectedRanges } from "../protect/protect.js";
import { builtinRuntime } from "../registry/builtins.js";
import { buildReceipt } from "../receipt/receipt.js";
import { renderContext } from "../render/render.js";
import { splitRawLines } from "../segment/segment.js";
import { parseHandle } from "../storage/handles.js";
import { measureTokens } from "../token/tokenizer.js";
import type { ValidationStore } from "./store-port.js";

function validateOutputPartition(
  preparedBytes: Buffer,
  mappings: readonly OutputMapping[]
): Result<void> {
  let cursor = 0;
  for (const [index, mapping] of mappings.entries()) {
    if (mapping.ordinal !== index || mapping.outputStartByte !== cursor) {
      return failure(
        "INTEGRITY_ERROR",
        "Output mappings are not an ordered complete partition",
        { index, cursor, mapping }
      );
    }
    if (
      mapping.outputEndByte < mapping.outputStartByte ||
      mapping.outputEndByte > preparedBytes.length
    ) {
      return failure("INTEGRITY_ERROR", "Output mapping range is invalid", {
        index,
        mapping
      });
    }
    cursor = mapping.outputEndByte;
  }
  return cursor === preparedBytes.length
    ? success(undefined)
    : failure(
        "INTEGRITY_ERROR",
        "Output mappings do not cover the complete prepared output",
        { coveredBytes: cursor, preparedBytes: preparedBytes.length }
      );
}

function sourceMappingsFor(
  artifact: ArtifactSnapshot,
  mappings: readonly OutputMapping[]
): Result<readonly OutputMapping[]> {
  const sourceMappings = mappings.filter(
    (mapping) =>
      mapping.artifactId === artifact.artifactId && mapping.kind !== "synthetic"
  );
  let cursor = 0;
  for (const mapping of sourceMappings) {
    if (
      mapping.sourceStartByte === undefined ||
      mapping.sourceEndByte === undefined ||
      mapping.sourceStartByte !== cursor ||
      mapping.sourceEndByte < mapping.sourceStartByte
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Artifact source mappings are not an ordered partition",
        { artifactId: artifact.artifactId, cursor, mapping }
      );
    }
    cursor = mapping.sourceEndByte;
  }
  if (cursor !== artifact.byteLength) {
    return failure(
      "INTEGRITY_ERROR",
      "Artifact source mappings do not cover every source byte",
      {
        artifactId: artifact.artifactId,
        coveredBytes: cursor,
        artifactBytes: artifact.byteLength
      }
    );
  }
  return success(sourceMappings);
}

export function validateContextPackage(input: {
  readonly contextPackage: ContextPackage;
  readonly artifacts: readonly ArtifactSnapshot[];
  readonly store: ValidationStore;
  readonly phase: "staging" | "committed";
}): Result<void> {
  const { contextPackage, artifacts, store, phase } = input;
  const { manifest, preparedBytes } = contextPackage;
  if (manifest.runId !== contextPackage.runId) {
    return failure(
      "INTEGRITY_ERROR",
      "Manifest run ID does not match the package run ID",
      {
        packageRunId: contextPackage.runId,
        manifestRunId: manifest.runId
      }
    );
  }
  const parsedManifest = canonicalManifestSchema.safeParse(manifest);
  if (!parsedManifest.success) {
    return failure("INTEGRITY_ERROR", "Manifest contract validation failed", {
      issues: parsedManifest.error.issues.map((issue) => issue.message)
    });
  }
  const storedProducers =
    phase === "staging"
      ? store.loadRunProducersForValidation(contextPackage.runId)
      : store.loadRunProducers(contextPackage.runId);
  if (!storedProducers.ok) return storedProducers;
  if (manifest.formatVersion === 2) {
    if (
      manifest.producerRegistry === undefined ||
      manifest.producerRegistry.digest !== builtinRuntime.registryDigest ||
      canonicalJson(manifest.producerRegistry.producers) !==
        canonicalJson(builtinRuntime.producers) ||
      canonicalJson(storedProducers.value) !==
        canonicalJson(builtinRuntime.producers)
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Producer registry does not match the validated runtime"
      );
    }
  } else if (
    manifest.producerRegistry !== undefined ||
    storedProducers.value.length > 0
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Legacy manifest contains unexpected producer metadata"
    );
  }

  if (
    canonicalJson(manifest) !== contextPackage.manifestJson ||
    sha256Base64Url(Buffer.from(contextPackage.manifestJson, "utf8")) !==
      contextPackage.manifestSha256
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Canonical manifest bytes or digest do not match"
    );
  }
  if (
    preparedBytes.toString("utf8") !== contextPackage.preparedText ||
    preparedBytes.length !== manifest.compactByteLength ||
    sha256Base64Url(preparedBytes) !== manifest.compactSha256
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Prepared output text, size, or digest does not match manifest"
    );
  }

  const runState = store.getRunState(contextPackage.runId);
  if (
    !runState.ok ||
    runState.value.status !== phase ||
    runState.value.validationStatus !==
      (phase === "staging" ? "pending" : "validated")
  ) {
    return failure("RUN_NOT_COMMITTED", "Run transaction is not committed", {
      runId: contextPackage.runId
    });
  }
  const storedManifest =
    phase === "staging"
      ? store.loadManifestForValidation(contextPackage.runId)
      : store.loadManifest(contextPackage.runId);
  if (
    !storedManifest.ok ||
    storedManifest.value.manifestSha256 !== contextPackage.manifestSha256 ||
    storedManifest.value.manifestJson !== contextPackage.manifestJson
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Stored canonical manifest does not match the release candidate"
    );
  }
  const storedPrepared =
    phase === "staging"
      ? store.loadPreparedBytesForValidation(contextPackage.runId)
      : store.loadPreparedBytes(contextPackage.runId);
  if (!storedPrepared.ok || !storedPrepared.value.equals(preparedBytes)) {
    return failure(
      "INTEGRITY_ERROR",
      "Stored prepared output does not match the release candidate"
    );
  }

  const artifactsById = new Map(
    artifacts.map((artifact) => [artifact.artifactId, artifact])
  );
  if (
    artifactsById.size !== artifacts.length ||
    artifacts.length !== manifest.artifacts.length
  ) {
    return failure("INTEGRITY_ERROR", "Artifact IDs are not unique");
  }
  for (const artifactManifest of manifest.artifacts) {
    const artifact = artifactsById.get(artifactManifest.artifactId);
    if (
      artifact === undefined ||
      artifact.byteLength !== artifactManifest.byteLength ||
      artifact.sha256 !== artifactManifest.sha256 ||
      artifact.ordinal !== artifactManifest.ordinal ||
      artifact.role !== artifactManifest.role ||
      canonicalJson(artifact.source) !==
        canonicalJson(artifactManifest.source) ||
      artifact.utf8 !== artifactManifest.utf8 ||
      artifact.hasBom !== artifactManifest.hasBom ||
      artifact.newlineStyle !== artifactManifest.newlineStyle ||
      artifact.hasAnsi !== artifactManifest.hasAnsi ||
      artifact.completeness !== artifactManifest.completeness ||
      artifact.completenessReason !== artifactManifest.completenessReason ||
      sha256Base64Url(artifact.bytes) !== artifactManifest.sha256
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Artifact bytes do not match their manifest",
        { artifactId: artifactManifest.artifactId }
      );
    }
  }

  const prompt = artifacts.find((artifact) => artifact.role === "prompt");
  if (prompt === undefined) {
    return failure("INTEGRITY_ERROR", "Manifest has no prompt artifact");
  }
  const recomputedClassifications = [];
  for (const artifact of artifacts) {
    const classification = builtinRuntime.classifyArtifact(artifact);
    if (!classification.ok) return classification;
    recomputedClassifications.push(classification.value);
  }
  const recomputedClassificationMap = new Map(
    recomputedClassifications.map((classification) => [
      classification.artifactId,
      classification
    ])
  );
  const recomputedArtifactOutcomes = new Map<
    string,
    "green" | "red" | "unknown"
  >();
  for (const artifact of artifacts) {
    if (artifact.role === "prompt") {
      recomputedArtifactOutcomes.set(artifact.artifactId, "unknown");
      continue;
    }
    const detected = builtinRuntime.detectOutcome(artifact);
    if (!detected.ok) return detected;
    recomputedArtifactOutcomes.set(artifact.artifactId, detected.value);
  }
  const contextOutcomes = artifacts
    .filter((artifact) => artifact.role === "context")
    .map(
      (artifact) =>
        recomputedArtifactOutcomes.get(artifact.artifactId) ?? "unknown"
    );
  const recomputedOutcome = contextOutcomes.includes("red")
    ? "red"
    : contextOutcomes.length > 0 &&
        contextOutcomes.every((outcome) => outcome === "green")
      ? "green"
      : "unknown";
  const recomputedEvidence = [];
  for (const artifact of artifacts) {
    const classification = recomputedClassificationMap.get(
      artifact.artifactId
    );
    if (classification === undefined) continue;
    const detected = builtinRuntime.detectEvidence({
      artifact,
      classification,
      outcome:
        recomputedArtifactOutcomes.get(artifact.artifactId) ?? "unknown"
    });
    if (!detected.ok) return detected;
    recomputedEvidence.push(...detected.value.findings);
  }
  const recomputedProtected = [];
  const recomputedTransforms = [];
  for (const artifact of artifacts) {
    const classification = recomputedClassificationMap.get(
      artifact.artifactId
    );
    if (classification === undefined) continue;
    const segmented = builtinRuntime.segment(artifact);
    if (!segmented.ok) return segmented;
    const artifactProtected = buildProtectedRanges(
      artifact,
      recomputedEvidence.filter(
        (item) => item.artifactId === artifact.artifactId
      ),
      segmented.value,
      { nearbySegments: manifest.policy.nearbySegments }
    );
    recomputedProtected.push(...artifactProtected);
    const detectedReductions = builtinRuntime.detectReductions({
      artifact,
      classification,
      outcome:
        recomputedArtifactOutcomes.get(artifact.artifactId) ?? "unknown"
    });
    if (!detectedReductions.ok) return detectedReductions;
    const decision = builtinRuntime.plan({
      runId: contextPackage.runId,
      artifact,
      proposals: detectedReductions.value.findings,
      protectedRanges: artifactProtected
    });
    if (!decision.ok) return decision;
    recomputedTransforms.push(...(decision.value.value ?? []));
  }
  const manifestArtifactSemantics = manifest.artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    classification: artifact.classification,
    outcome: artifact.outcome
  }));
  const recomputedArtifactSemantics = artifacts.map((artifact) => ({
    artifactId: artifact.artifactId,
    classification: recomputedClassificationMap.get(artifact.artifactId),
    outcome:
      recomputedArtifactOutcomes.get(artifact.artifactId) ?? "unknown"
  }));
  if (
    (() => {
      const recomputedIntent = builtinRuntime.classifyIntent(prompt);
      return (
        !recomputedIntent.ok ||
        canonicalJson(manifest.intent) !==
          canonicalJson(recomputedIntent.value)
      );
    })() ||
    manifest.outcome !== recomputedOutcome ||
    canonicalJson(manifestArtifactSemantics) !==
      canonicalJson(recomputedArtifactSemantics) ||
    canonicalJson(manifest.evidence) !== canonicalJson(recomputedEvidence) ||
    canonicalJson(manifest.protectedRanges) !==
      canonicalJson(recomputedProtected) ||
    canonicalJson(manifest.transforms) !== canonicalJson(recomputedTransforms)
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Manifest classifications, evidence, protection, or plan are not source-derived"
    );
  }

  const evidenceIds = new Set<string>();
  const occurrenceIds = new Set<string>();
  for (const item of manifest.evidence) {
    const artifact = artifactsById.get(item.artifactId);
    if (artifact === undefined) {
      return failure("INTEGRITY_ERROR", "Evidence references an unknown artifact", {
        evidenceId: item.evidenceId
      });
    }
    try {
      assertRange(item, artifact.byteLength);
    } catch (error) {
      return failure("INTEGRITY_ERROR", "Evidence range is invalid", {
        evidenceId: item.evidenceId,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    const bytes = artifact.bytes.subarray(item.startByte, item.endByte);
    if (
      evidenceIds.has(item.evidenceId) ||
      occurrenceIds.has(item.occurrenceId) ||
      sha256Base64Url(bytes) !== item.sha256
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Evidence occurrence identity or digest validation failed",
        { evidenceId: item.evidenceId, occurrenceId: item.occurrenceId }
      );
    }
    evidenceIds.add(item.evidenceId);
    occurrenceIds.add(item.occurrenceId);
  }

  for (const protectedRange of manifest.protectedRanges) {
    const artifact = artifactsById.get(protectedRange.artifactId);
    if (artifact === undefined) {
      return failure(
        "INTEGRITY_ERROR",
        "Protected range references an unknown artifact",
        { artifactId: protectedRange.artifactId }
      );
    }
    try {
      assertRange(protectedRange, artifact.byteLength);
    } catch (error) {
      return failure("INTEGRITY_ERROR", "Protected range is invalid", {
        artifactId: protectedRange.artifactId,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    if (
      protectedRange.evidenceIds.some(
        (evidenceId) => !evidenceIds.has(evidenceId)
      )
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Protected range references unknown evidence",
        { artifactId: protectedRange.artifactId }
      );
    }
  }

  for (const transform of manifest.transforms) {
    const artifact = artifactsById.get(transform.artifactId);
    if (artifact === undefined) {
      return failure("INTEGRITY_ERROR", "Transform references unknown artifact", {
        proposalId: transform.proposalId
      });
    }
    try {
      assertRange(transform, artifact.byteLength);
    } catch (error) {
      return failure("INTEGRITY_ERROR", "Transform range is invalid", {
        proposalId: transform.proposalId,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    if (
      manifest.protectedRanges.some(
        (protectedRange) =>
          protectedRange.artifactId === transform.artifactId &&
          rangesIntersect(protectedRange, transform)
      )
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Transform intersects a protected range",
        { proposalId: transform.proposalId }
      );
    }
  }
  for (const artifact of artifacts) {
    const transforms = manifest.transforms.filter(
      (transform) => transform.artifactId === artifact.artifactId
    );
    let end = 0;
    for (const transform of transforms) {
      if (transform.startByte < end) {
        return failure("INTEGRITY_ERROR", "Transform plan overlaps or is unordered", {
          artifactId: artifact.artifactId
        });
      }
      end = transform.endByte;
    }
  }

  const outputPartition = validateOutputPartition(
    preparedBytes,
    manifest.outputMappings
  );
  if (!outputPartition.ok) return outputPartition;

  for (const mapping of manifest.outputMappings) {
    if (
      mapping.outputStartByte < 0 ||
      mapping.outputEndByte > preparedBytes.length
    ) {
      return failure("INTEGRITY_ERROR", "Output mapping exceeds compact output");
    }
    if (mapping.kind === "synthetic") continue;
    const artifact =
      mapping.artifactId === undefined
        ? undefined
        : artifactsById.get(mapping.artifactId);
    if (
      artifact === undefined ||
      mapping.sourceStartByte === undefined ||
      mapping.sourceEndByte === undefined
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Source mapping is missing artifact or source coordinates",
        { mappingId: mapping.mappingId }
      );
    }
    try {
      assertRange(
        {
          startByte: mapping.sourceStartByte,
          endByte: mapping.sourceEndByte
        },
        artifact.byteLength
      );
    } catch (error) {
      return failure("INTEGRITY_ERROR", "Source mapping range is invalid", {
        mappingId: mapping.mappingId,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
    const outputBytes = preparedBytes.subarray(
      mapping.outputStartByte,
      mapping.outputEndByte
    );
    if (mapping.kind === "literal") {
      const sourceBytes = artifact.bytes.subarray(
        mapping.sourceStartByte,
        mapping.sourceEndByte
      );
      if (!outputBytes.equals(sourceBytes)) {
        return failure(
          "INTEGRITY_ERROR",
          "Literal output mapping is not byte-identical",
          { mappingId: mapping.mappingId }
        );
      }
    }
  }

  const omissionsByHandle = new Map(
    manifest.omissions.map((omission) => [omission.handle, omission])
  );
  if (omissionsByHandle.size !== manifest.omissions.length) {
    return failure("INTEGRITY_ERROR", "Omission handles are not unique");
  }
  if (manifest.transforms.length !== manifest.omissions.length) {
    return failure(
      "INTEGRITY_ERROR",
      "Transform and omission cardinalities do not match"
    );
  }
  const transformsByOccurrence = new Map(
    manifest.transforms.map((transform) => [
      transform.occurrenceId,
      transform
    ])
  );
  if (transformsByOccurrence.size !== manifest.transforms.length) {
    return failure("INTEGRITY_ERROR", "Transform occurrence IDs are not unique");
  }
  for (const omission of manifest.omissions) {
    const artifact = artifactsById.get(omission.artifactId);
    const transform = transformsByOccurrence.get(omission.occurrenceId);
    const parsedHandle = parseHandle(omission.handle);
    if (
      artifact === undefined ||
      transform === undefined ||
      !parsedHandle.ok ||
      parsedHandle.value.occurrenceId !== omission.occurrenceId ||
      parsedHandle.value.digest !== omission.sha256 ||
      parsedHandle.value.byteLength !== omission.byteLength ||
      transform.artifactId !== omission.artifactId ||
      transform.startByte !== omission.startByte ||
      transform.endByte !== omission.endByte ||
      transform.reason !== omission.reason ||
      transform.sourceCount !== omission.sourceCount ||
      transform.handle !== omission.handle ||
      transform.omittedSha256 !== omission.sha256 ||
      transform.omittedByteLength !== omission.byteLength ||
      transform.marker !== omission.marker
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Omission does not match exactly one transform",
        { occurrenceId: omission.occurrenceId }
      );
    }
    if (
      manifest.protectedRanges.some(
        (protectedRange) =>
          protectedRange.artifactId === omission.artifactId &&
          rangesIntersect(protectedRange, omission)
      )
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Omission directly intersects a protected range",
        { occurrenceId: omission.occurrenceId }
      );
    }
    if (
      omission.byteLength <= Buffer.byteLength(omission.marker, "utf8")
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Non-beneficial omission was included in the plan",
        { occurrenceId: omission.occurrenceId }
      );
    }
  }
  for (const mapping of manifest.outputMappings.filter(
    (candidate) => candidate.kind === "omission"
  )) {
    const omission =
      mapping.handle === undefined
        ? undefined
        : omissionsByHandle.get(mapping.handle);
    if (
      omission === undefined ||
      mapping.artifactId !== omission.artifactId ||
      mapping.sourceStartByte !== omission.startByte ||
      mapping.sourceEndByte !== omission.endByte
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Omission mapping does not have exactly one matching omission",
        { mappingId: mapping.mappingId }
      );
    }
    const markerBytes = preparedBytes.subarray(
      mapping.outputStartByte,
      mapping.outputEndByte
    );
    if (markerBytes.toString("utf8") !== omission.marker) {
      return failure("INTEGRITY_ERROR", "Omission marker bytes do not match", {
        handle: omission.handle
      });
    }
    const markerPattern =
      /^\[CTXO OMIT r=([^ ]+) c=(\d+) b=(\d+) h=([^\]]+)\]\n$/;
    const markerMatch = markerPattern.exec(omission.marker);
    if (
      markerMatch?.[1] !== omission.reason ||
      Number(markerMatch?.[2]) !== omission.sourceCount ||
      Number(markerMatch?.[3]) !== omission.byteLength ||
      markerMatch?.[4] !== omission.handle
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Omission marker metadata is not source-derived",
        { handle: omission.handle }
      );
    }
    const artifact = artifactsById.get(omission.artifactId);
    if (artifact === undefined) {
      return failure("INTEGRITY_ERROR", "Omission artifact was not found");
    }
    const sourceBytes = artifact.bytes.subarray(
      omission.startByte,
      omission.endByte
    );
    if (
      sourceBytes.length !== omission.byteLength ||
      sha256Base64Url(sourceBytes) !== omission.sha256 ||
      splitRawLines(sourceBytes).length !== omission.sourceCount
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Omission size, digest, or count does not match source bytes",
        { handle: omission.handle }
      );
    }
    const retrieved =
      phase === "staging"
        ? store.retrieveForValidation(contextPackage.runId, omission.handle)
        : store.retrieve(omission.handle);
    if (!retrieved.ok || !retrieved.value.equals(sourceBytes)) {
      return failure(
        "INTEGRITY_ERROR",
        "Omission handle failed real SQLite readback",
        { handle: omission.handle }
      );
    }
  }
  if (
    manifest.outputMappings.filter((mapping) => mapping.kind === "omission")
      .length !== manifest.omissions.length
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Every omitted source range must have exactly one mapping"
    );
  }

  const mandatoryEvidence = manifest.evidence.filter(
    (item) => item.mandatoryInline
  );
  const evidenceMappings = new Map(
    manifest.evidenceMappings.map((mapping) => [mapping.evidenceId, mapping])
  );
  if (
    evidenceMappings.size !== mandatoryEvidence.length ||
    manifest.evidenceMappings.length !== mandatoryEvidence.length
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Every evidence occurrence requires its own output mapping"
    );
  }
  for (const item of mandatoryEvidence) {
    const mapping = evidenceMappings.get(item.evidenceId);
    const artifact = artifactsById.get(item.artifactId);
    if (
      mapping === undefined ||
      artifact === undefined ||
      mapping.occurrenceId !== item.occurrenceId ||
      mapping.sourceStartByte !== item.startByte ||
      mapping.sourceEndByte !== item.endByte ||
      mapping.sha256 !== item.sha256
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Occurrence-specific evidence mapping metadata mismatch",
        { evidenceId: item.evidenceId }
      );
    }
    const sourceBytes = artifact.bytes.subarray(item.startByte, item.endByte);
    const outputBytes = preparedBytes.subarray(
      mapping.outputStartByte,
      mapping.outputEndByte
    );
    const containingLiteral = manifest.outputMappings.find(
      (candidate) =>
        candidate.kind === "literal" &&
        candidate.artifactId === item.artifactId &&
        candidate.sourceStartByte !== undefined &&
        candidate.sourceEndByte !== undefined &&
        candidate.sourceStartByte <= item.startByte &&
        candidate.sourceEndByte >= item.endByte
    );
    const expectedOutputStart =
      containingLiteral?.sourceStartByte === undefined
        ? undefined
        : containingLiteral.outputStartByte +
          item.startByte -
          containingLiteral.sourceStartByte;
    if (
      expectedOutputStart === undefined ||
      mapping.outputStartByte !== expectedOutputStart ||
      mapping.outputEndByte !==
        expectedOutputStart + item.endByte - item.startByte ||
      !sourceBytes.equals(outputBytes) ||
      sha256Base64Url(outputBytes) !== item.sha256
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Protected evidence occurrence is not byte-identical inline",
        { evidenceId: item.evidenceId }
      );
    }
  }

  for (const artifact of artifacts) {
    const sourceMappings = sourceMappingsFor(
      artifact,
      manifest.outputMappings
    );
    if (!sourceMappings.ok) return sourceMappings;
    const reconstructed: Buffer[] = [];
    for (const mapping of sourceMappings.value) {
      if (mapping.kind === "literal") {
        reconstructed.push(
          preparedBytes.subarray(
            mapping.outputStartByte,
            mapping.outputEndByte
          )
        );
      } else if (mapping.kind === "omission" && mapping.handle !== undefined) {
        const retrieved =
          phase === "staging"
            ? store.retrieveForValidation(contextPackage.runId, mapping.handle)
            : store.retrieve(mapping.handle);
        if (!retrieved.ok) return retrieved;
        reconstructed.push(retrieved.value);
      }
    }
    if (!Buffer.concat(reconstructed).equals(artifact.bytes)) {
      return failure(
        "INTEGRITY_ERROR",
        "Artifact reconstruction is not byte-identical",
        { artifactId: artifact.artifactId }
      );
    }
  }

  const plans = new Map<string, typeof manifest.transforms>();
  for (const artifact of artifacts) {
    plans.set(
      artifact.artifactId,
      manifest.transforms.filter(
        (transform) => transform.artifactId === artifact.artifactId
      )
    );
  }
  let rerendered;
  try {
    rerendered = renderContext(
      artifacts,
      plans,
      manifest.evidence as readonly EvidenceSpan[]
    );
  } catch (error) {
    return failure("INTEGRITY_ERROR", "Deterministic re-render failed", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  if (
    !rerendered.preparedBytes.equals(preparedBytes) ||
    canonicalJson(rerendered.outputMappings) !==
      canonicalJson(manifest.outputMappings) ||
    canonicalJson(rerendered.evidenceMappings) !==
      canonicalJson(manifest.evidenceMappings) ||
    canonicalJson(rerendered.omissions) !== canonicalJson(manifest.omissions)
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Prepared output does not match deterministic rendering"
    );
  }

  const uncompressed = renderContext(
    artifacts,
    new Map<string, readonly never[]>(),
    manifest.evidence as readonly EvidenceSpan[]
  ).preparedBytes;
  const tokens = measureTokens(
    uncompressed.toString("utf8"),
    preparedBytes.toString("utf8")
  );
  if (
    !tokens.ok ||
    tokens.value.originalTokens !== manifest.tokenizer.originalTokens ||
    tokens.value.preparedTokens !== manifest.tokenizer.preparedTokens
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Actual tokenizer measurement does not match manifest"
    );
  }

  return success(undefined);
}

export function verifyStoredRun(
  store: ValidationStore,
  runId: string
): Result<ValidatedContextPackage> {
  const storedManifest = store.loadManifest(runId);
  if (!storedManifest.ok) return storedManifest;
  const prepared = store.loadPreparedBytes(runId);
  if (!prepared.ok) return prepared;
  const artifactBytes = store.loadArtifactBytes(runId);
  if (!artifactBytes.ok) return artifactBytes;
  const snapshotsResult = snapshotsFromManifest(
    storedManifest.value.manifest,
    artifactBytes.value
  );
  if (!snapshotsResult.ok) return snapshotsResult;
  const receipt = store.inspectReceipt(runId);
  if (!receipt.ok) return receipt;
  const expectedReceipt = buildReceipt({
    runId,
    classifications: storedManifest.value.manifest.artifacts.map(
      (artifact) => artifact.classification
    ),
    intent: storedManifest.value.manifest.intent,
    outcome: storedManifest.value.manifest.outcome,
    originalBytes: storedManifest.value.manifest.originalByteLength,
    preparedBytes: storedManifest.value.manifest.compactByteLength,
    tokens: storedManifest.value.manifest.tokenizer,
    evidence: storedManifest.value.manifest.evidence,
    omissions: storedManifest.value.manifest.omissions,
    warnings: receipt.value.warnings
  });
  if (canonicalJson(expectedReceipt) !== canonicalJson(receipt.value)) {
    return failure(
      "INTEGRITY_ERROR",
      "Stored receipt does not match the committed manifest"
    );
  }
  const validated = validateContextPackage({
    contextPackage: {
      runId,
      preparedBytes: prepared.value,
      preparedText: prepared.value.toString("utf8"),
      manifest: storedManifest.value.manifest,
      manifestJson: storedManifest.value.manifestJson,
      manifestSha256: storedManifest.value.manifestSha256
    },
    artifacts: snapshotsResult.value,
    store,
    phase: "committed"
  });
  if (!validated.ok) return validated;
  return success({
    runId,
    preparedBytes: prepared.value,
    preparedText: prepared.value.toString("utf8"),
    manifest: storedManifest.value.manifest,
    manifestJson: storedManifest.value.manifestJson,
    manifestSha256: storedManifest.value.manifestSha256,
    validation: {
      status: "validated",
      reconstruction: "byte-identical",
      committed: true
    }
  });
}

export function snapshotsFromManifest(
  manifest: CanonicalManifest,
  bytesByArtifact: ReadonlyMap<string, Buffer>
): Result<readonly ArtifactSnapshot[]> {
  const snapshots: ArtifactSnapshot[] = [];
  for (const artifact of manifest.artifacts) {
    const bytes = bytesByArtifact.get(artifact.artifactId);
    if (bytes === undefined) {
      return failure("INTEGRITY_ERROR", "Artifact blob is missing", {
        artifactId: artifact.artifactId
      });
    }
    snapshots.push({
      artifactId: artifact.artifactId,
      ordinal: artifact.ordinal,
      role: artifact.role,
      source: artifact.source,
      bytes,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
      utf8: artifact.utf8,
      hasBom: artifact.hasBom,
      newlineStyle: artifact.newlineStyle,
      hasAnsi: artifact.hasAnsi,
      completeness: artifact.completeness,
      completenessReason: artifact.completenessReason
    });
  }
  return success(snapshots);
}
