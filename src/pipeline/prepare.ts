import { randomUUID } from "node:crypto";

import { detectMissingCiFailureEvidence } from "../ci/envelope.js";
import type {
  ArtifactManifest,
  ArtifactSnapshot,
  CanonicalManifest,
  PrepareResult,
  ProtectedRange
} from "../contracts/types.js";
import { canonicalJson } from "../core/canonical.js";
import { sha256Base64Url } from "../core/hash.js";
import { failure, success, type Result } from "../core/result.js";
import {
  DEFAULT_MAX_ARTIFACT_BYTES,
  intakePastedText,
  intakeUtf8File
} from "../intake/intake.js";
import { buildProtectedRanges } from "../protect/protect.js";
import { builtinRuntime } from "../registry/builtins.js";
import { buildReceipt } from "../receipt/receipt.js";
import { renderContext } from "../render/render.js";
import { ContextStore } from "../storage/store.js";
import { measureTokens } from "../token/tokenizer.js";

export interface PrepareInput {
  readonly promptFile?: string;
  readonly promptText?: string;
  readonly contextFiles?: readonly string[];
  readonly contextTexts?: readonly {
    readonly label: string;
    readonly text: string;
  }[];
  readonly storePath: string;
  readonly maxArtifactBytes?: number;
  readonly nearbySegments?: number;
}

async function captureArtifacts(
  input: PrepareInput
): Promise<Result<readonly ArtifactSnapshot[]>> {
  if ((input.promptFile === undefined) === (input.promptText === undefined)) {
    return failure(
      "INVALID_ARGUMENT",
      "Provide exactly one of promptFile or promptText"
    );
  }
  const maxArtifactBytes =
    input.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  const artifacts: ArtifactSnapshot[] = [];
  if (input.promptFile !== undefined) {
    const result = await intakeUtf8File(
      input.promptFile,
      { ordinal: 0, role: "prompt", label: "prompt" },
      { maxArtifactBytes }
    );
    if (!result.ok) return result;
    artifacts.push(result.value);
  } else {
    const result = intakePastedText(
      input.promptText as string,
      { ordinal: 0, role: "prompt", label: "prompt" },
      { maxArtifactBytes }
    );
    if (!result.ok) return result;
    artifacts.push(result.value);
  }

  for (const path of input.contextFiles ?? []) {
    const result = await intakeUtf8File(
      path,
      { ordinal: artifacts.length, role: "context" },
      { maxArtifactBytes }
    );
    if (!result.ok) return result;
    artifacts.push(result.value);
  }
  for (const context of input.contextTexts ?? []) {
    const result = intakePastedText(
      context.text,
      {
        ordinal: artifacts.length,
        role: "context",
        label: context.label
      },
      { maxArtifactBytes }
    );
    if (!result.ok) return result;
    artifacts.push(result.value);
  }
  return success(artifacts);
}

export async function prepareContext(input: PrepareInput): Promise<PrepareResult> {
  const captured = await captureArtifacts(input);
  if (!captured.ok) return captured;
  const artifacts = captured.value;
  const prompt = artifacts[0];
  if (prompt === undefined) {
    return failure("INVALID_ARGUMENT", "Prompt artifact is required");
  }

  const classifications = [];
  for (const artifact of artifacts) {
    const classification = builtinRuntime.classifyArtifact(artifact);
    if (!classification.ok) return classification;
    classifications.push(classification.value);
  }
  const classificationMap = new Map(
    classifications.map((classification) => [
      classification.artifactId,
      classification
    ])
  );
  const intentResult = builtinRuntime.classifyIntent(prompt);
  if (!intentResult.ok) return intentResult;
  const intent = intentResult.value;
  const artifactOutcomes = new Map<string, "green" | "red" | "unknown">();
  for (const artifact of artifacts) {
    if (artifact.role === "prompt") {
      artifactOutcomes.set(artifact.artifactId, "unknown");
      continue;
    }
    const detected = builtinRuntime.detectOutcome(artifact);
    if (!detected.ok) return detected;
    artifactOutcomes.set(artifact.artifactId, detected.value);
  }
  const contextOutcomes = artifacts
    .filter((artifact) => artifact.role === "context")
    .map((artifact) => artifactOutcomes.get(artifact.artifactId) ?? "unknown");
  const outcome = contextOutcomes.includes("red")
    ? "red"
    : contextOutcomes.length > 0 &&
        contextOutcomes.every((item) => item === "green")
      ? "green"
      : "unknown";
  const runId = randomUUID();
  const evidence = [];
  for (const artifact of artifacts) {
    const classification = classificationMap.get(artifact.artifactId);
    if (classification === undefined) continue;
    const detected = builtinRuntime.detectEvidence({
      artifact,
      classification,
      outcome: artifactOutcomes.get(artifact.artifactId) ?? "unknown"
    });
    if (!detected.ok) return detected;
    evidence.push(...detected.value.findings);
  }

  const protectedRanges: ProtectedRange[] = [];
  const plans = new Map();
  const warnings: string[] = [];
  const nearbySegments = input.nearbySegments ?? 1;
  for (const artifact of artifacts) {
    const artifactEvidence = evidence.filter(
      (item) => item.artifactId === artifact.artifactId
    );
    const segmented = builtinRuntime.segment(artifact);
    if (!segmented.ok) return segmented;
    const segments = segmented.value;
    const missingCiEvidence = detectMissingCiFailureEvidence(artifact);
    if (missingCiEvidence !== undefined) warnings.push(missingCiEvidence);
    const protection = buildProtectedRanges(
      artifact,
      artifactEvidence,
      segments,
      { nearbySegments }
    );
    protectedRanges.push(...protection);
    const classification = classificationMap.get(artifact.artifactId);
    if (classification === undefined) {
      return failure(
        "CLASSIFICATION_ERROR",
        "Artifact classification disappeared during preparation",
        { artifactId: artifact.artifactId }
      );
    }
    const detectedReductions = builtinRuntime.detectReductions({
      artifact,
      classification,
      outcome: artifactOutcomes.get(artifact.artifactId) ?? "unknown"
    });
    if (!detectedReductions.ok) return detectedReductions;
    const decision = builtinRuntime.plan({
      runId,
      artifact,
      proposals: detectedReductions.value.findings,
      protectedRanges: protection
    });
    if (!decision.ok) return decision;
    plans.set(artifact.artifactId, decision.value.value ?? []);
    warnings.push(
      ...decision.value.reasons
        .filter((reason) => !reason.startsWith("0 "))
        .map((reason) => `${reason} in ${artifact.source.label}`)
    );
    if (artifact.completeness !== "complete") {
      warnings.push(
        `Reduction abstained for incomplete artifact ${artifact.source.label}: ${artifact.completenessReason}`
      );
    }
  }

  let rendered;
  let uncompressed;
  try {
    rendered = renderContext(artifacts, plans, evidence);
    uncompressed = renderContext(
      artifacts,
      new Map<string, readonly never[]>(),
      evidence
    );
  } catch (error) {
    return failure("INTEGRITY_ERROR", "Rendering failed closed", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  const tokenMeasurement = measureTokens(
    uncompressed.preparedBytes.toString("utf8"),
    rendered.preparedBytes.toString("utf8")
  );
  if (!tokenMeasurement.ok) return tokenMeasurement;

  const createdAt = new Date().toISOString();
  const artifactManifests: ArtifactManifest[] = artifacts.map((artifact) => {
    const classification = classificationMap.get(artifact.artifactId);
    if (classification === undefined) {
      throw new Error(`Missing classification for ${artifact.artifactId}`);
    }
    return {
      artifactId: artifact.artifactId,
      ordinal: artifact.ordinal,
      role: artifact.role,
      source: artifact.source,
      byteLength: artifact.byteLength,
      sha256: artifact.sha256,
      utf8: artifact.utf8,
      hasBom: artifact.hasBom,
      newlineStyle: artifact.newlineStyle,
      hasAnsi: artifact.hasAnsi,
      completeness: artifact.completeness,
      completenessReason: artifact.completenessReason,
      outcome: artifactOutcomes.get(artifact.artifactId) ?? "unknown",
      classification
    };
  });
  const transforms = artifacts.flatMap(
    (artifact) => plans.get(artifact.artifactId) ?? []
  );
  const manifest: CanonicalManifest = {
    formatVersion: 2,
    runId,
    createdAt,
    artifacts: artifactManifests,
    intent,
    outcome,
    policy: { nearbySegments },
    producerRegistry: {
      digest: builtinRuntime.preparationRegistryDigest,
      producers: builtinRuntime.preparationProducers
    },
    evidence,
    protectedRanges,
    transforms,
    omissions: rendered.omissions,
    outputMappings: rendered.outputMappings,
    evidenceMappings: rendered.evidenceMappings,
    compactSha256: sha256Base64Url(rendered.preparedBytes),
    compactByteLength: rendered.preparedBytes.length,
    originalByteLength: artifacts.reduce(
      (total, artifact) => total + artifact.byteLength,
      0
    ),
    tokenizer: tokenMeasurement.value
  };
  const manifestJson = canonicalJson(manifest);
  const manifestSha256 = sha256Base64Url(Buffer.from(manifestJson, "utf8"));
  const contextPackage = {
    runId,
    preparedBytes: rendered.preparedBytes,
    preparedText: rendered.preparedBytes.toString("utf8"),
    manifest,
    manifestJson,
    manifestSha256
  };

  let store: ContextStore;
  try {
    store = new ContextStore(input.storePath);
  } catch (error) {
    return failure("STORAGE_ERROR", "Unable to open durable SQLite store", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  try {
    const staged = store.stageRun({
      runId,
      createdAt,
      artifacts,
      classifications: classificationMap,
      evidence,
      omissions: rendered.omissions,
      outputMappings: rendered.outputMappings,
      evidenceMappings: rendered.evidenceMappings,
      manifest,
      manifestJson,
      manifestSha256,
      preparedBytes: rendered.preparedBytes
    });
    if (!staged.ok) return staged;

    const receipt = buildReceipt({
      runId,
      classifications,
      intent,
      outcome,
      originalBytes: manifest.originalByteLength,
      preparedBytes: manifest.compactByteLength,
      tokens: tokenMeasurement.value,
      evidence,
      omissions: rendered.omissions,
      warnings
    });
    const published = store.publishValidated({
      contextPackage,
      receipt
    });
    if (!published.ok) return published;
    return {
      ok: true,
      value: {
        package: published.value,
        receipt
      }
    };
  } finally {
    store.close();
  }
}
