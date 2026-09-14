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
import { renderContext } from "../render/render.js";
import { splitRawLines } from "../segment/segment.js";
import type { ContextStore } from "../storage/store.js";
import { measureTokens } from "../token/tokenizer.js";

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
  readonly store: ContextStore;
  readonly phase: "staging" | "committed";
}): Result<void> {
  const { contextPackage, artifacts, store, phase } = input;
  const { manifest, preparedBytes } = contextPackage;
  const parsedManifest = canonicalManifestSchema.safeParse(manifest);
  if (!parsedManifest.success) {
    return failure("INTEGRITY_ERROR", "Manifest contract validation failed", {
      issues: parsedManifest.error.issues.map((issue) => issue.message)
    });
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
  if (artifactsById.size !== artifacts.length) {
    return failure("INTEGRITY_ERROR", "Artifact IDs are not unique");
  }
  for (const artifactManifest of manifest.artifacts) {
    const artifact = artifactsById.get(artifactManifest.artifactId);
    if (
      artifact === undefined ||
      artifact.byteLength !== artifactManifest.byteLength ||
      artifact.sha256 !== artifactManifest.sha256 ||
      sha256Base64Url(artifact.bytes) !== artifactManifest.sha256
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Artifact bytes do not match their manifest",
        { artifactId: artifactManifest.artifactId }
      );
    }
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
    if (
      artifact === undefined ||
      transform === undefined ||
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
      /^\[CTXO OMIT reason=([^ ]+) count=(\d+) bytes=(\d+) handle=([^\]]+)\]\n$/;
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

  const evidenceMappings = new Map(
    manifest.evidenceMappings.map((mapping) => [mapping.evidenceId, mapping])
  );
  if (
    evidenceMappings.size !== manifest.evidence.length ||
    manifest.evidenceMappings.length !== manifest.evidence.length
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Every evidence occurrence requires its own output mapping"
    );
  }
  for (const item of manifest.evidence) {
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
    if (
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
  store: ContextStore,
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
