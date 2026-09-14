import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { OfflineHandoffPort } from "../src/ports/handoff.js";
import type { ApprovedSourceCandidate } from "../src/contracts/provenance.js";
import type { SourceDocument } from "../src/contracts/source-scope.js";
import { canonicalJsonDigest } from "../src/core/canonical.js";
import { sha256Base64Url } from "../src/core/hash.js";
import { ExternalLocalFixtureAdapter } from "../src/evaluation/external.js";
import {
  createReplayManifest
} from "../src/evaluation/harness.js";
import { createCuratedModelPolicy, deterministicModelFitAdviser } from "../src/model/advice.js";
import { assessFailureEvidence } from "../src/obligations/evaluate.js";
import { prepareContext } from "../src/pipeline/prepare.js";
import {
  exactSourceProvenanceProvider,
  renderUniqueSourceLink
} from "../src/provenance/exact.js";
import { renderContext } from "../src/render/render.js";
import { assessSecurity } from "../src/security/security.js";
import { buildDeliveryPlan } from "../src/source/delivery.js";
import { ContextStore } from "../src/storage/store.js";
import { TerminalReviewController } from "../src/tui/review.js";
import {
  snapshotsFromManifest,
  verifyStoredRun
} from "../src/validate/validate.js";
import { typedFailureParsers } from "../src/parsers/failures.js";
import { CommittedRunScopeAuthority } from "../src/adapters/run-authority.js";

const outputDirectory = resolve(".context-overflow");
await mkdir(outputDirectory, { recursive: true });
const storePath = resolve(
  outputDirectory,
  `day0-5-${Date.now()}.sqlite`
);
const prepared = await prepareContext({
  promptText: "Summarize the routine build trace and preserve exact provenance.",
  contextTexts: [
    {
      label: "routine-demo.log",
      text: `${"Restored routine package cache for demo\n".repeat(180)}Process exited with code 0\n`
    }
  ],
  storePath
});
if (!prepared.ok) throw new Error(prepared.error.message);

const store = new ContextStore(storePath);
try {
  const verified = verifyStoredRun(store, prepared.value.package.runId);
  if (!verified.ok) throw new Error(verified.error.message);
  const artifactBytes = store.loadArtifactBytes(verified.value.runId);
  if (!artifactBytes.ok) throw new Error(artifactBytes.error.message);
  const snapshots = snapshotsFromManifest(
    verified.value.manifest,
    artifactBytes.value
  );
  if (!snapshots.ok) throw new Error(snapshots.error.message);
  const originalBytes = renderContext(
    snapshots.value,
    new Map<string, readonly never[]>(),
    verified.value.manifest.evidence
  ).preparedBytes;

  const reports = snapshots.value.flatMap((artifact) => {
    const parsed = typedFailureParsers.parse(artifact);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.value;
  });
  const evidenceAssessment = assessFailureEvidence({
    artifact: snapshots.value[1] as (typeof snapshots.value)[number],
    evidence: verified.value.manifest.evidence
  });
  if (!evidenceAssessment.ok) throw new Error(evidenceAssessment.error.message);

  const sourceBytes = Buffer.from(
    "export interface Config { enabled: boolean }\nexport function run(config: Config) { return config.enabled; }\n",
    "utf8"
  );
  const sourceCandidate: ApprovedSourceCandidate = {
    candidateId: "demo-source",
    label: "src/demo.ts",
    approved: true,
    bytes: sourceBytes,
    identity: {
      sha256: sha256Base64Url(sourceBytes),
      byteLength: sourceBytes.length
    }
  };
  const provenance = exactSourceProvenanceProvider.provide({
    query: Buffer.from("export function run", "utf8"),
    candidates: [sourceCandidate]
  });
  if (!provenance.ok) throw new Error(provenance.error.message);
  const sourceLink = renderUniqueSourceLink(provenance.value, [
    sourceCandidate
  ]);
  if (!sourceLink.ok) throw new Error(sourceLink.error.message);

  const sourceDocument: SourceDocument = {
    sourceId: "demo-source",
    path: resolve("src\\demo.ts"),
    language: "typescript",
    bytes: sourceBytes,
    identity: sourceCandidate.identity
  };
  const delivery = buildDeliveryPlan({
    documents: [sourceDocument],
    roots: [{ sourceId: "demo-source", symbol: "run" }],
    rules: {
      maxFiles: 4,
      maxBytes: 8_192,
      maxDepth: 2,
      includeImports: true,
      includeDefinitions: true,
      includeTypes: true,
      includeTests: true
    }
  });
  if (!delivery.ok) throw new Error(delivery.error.message);

  const policy = createCuratedModelPolicy({
    version: "demo-1",
    entries: [
      {
        modelId: "routine-demo",
        allowedOperations: ["MF-02-bounded-routine"],
        enabled: true
      }
    ]
  });
  const modelAdvice = deterministicModelFitAdviser.provide({
    operation: "MF-02-bounded-routine",
    currentModelId: "routine-demo",
    requiredInputTokens: verified.value.manifest.tokenizer.preparedTokens,
    requiresTools: false,
    requiresVision: false,
    evidenceDecision: evidenceAssessment.value.sufficiency.decision,
    catalog: [
      {
        id: "routine-demo",
        name: "Routine Demo",
        capabilities: {
          maxInputTokens: 64_000,
          supportsTools: true,
          latencyTier: 1,
          costTier: 1
        }
      }
    ],
    policy
  });
  if (!modelAdvice.ok) throw new Error(modelAdvice.error.message);

  const controller = new TerminalReviewController(
    {
      contextPackage: verified.value,
      receipt: prepared.value.receipt,
      capturedBytes: originalBytes,
      artifacts: snapshots.value,
      readScope: {
        runId: verified.value.runId,
        evidence: verified.value.manifest.evidence.map((evidence) => {
          const artifact = snapshots.value.find(
            (item) => item.artifactId === evidence.artifactId
          ) as (typeof snapshots.value)[number];
          return {
            span: evidence,
            bytes: artifact.bytes.subarray(
              evidence.startByte,
              evidence.endByte
            )
          };
        }),
        sources: []
      },
      approvalAuthority: new CommittedRunScopeAuthority(store),
      target: {
        adapterId: "offline",
        modelId: "routine-demo",
        workingDirectory: process.cwd(),
        permissions: {
          sourceRead: true,
          evidenceRead: true,
          fileWrite: false,
          shell: false,
          network: false
        }
      }
    },
    store
  );
  const approved = controller.dispatch({ type: "approve-prepared" });
  if (!approved.ok) throw new Error(approved.error.message);
  const approvedPayload = controller.approvedPayload();
  if (!approvedPayload.ok) throw new Error(approvedPayload.error.message);
  const handoff = await new OfflineHandoffPort().handoff(verified.value);
  if (!handoff.ok) throw new Error(handoff.error.message);

  const security = assessSecurity(
    snapshots.value.map((artifact) => ({
      sourceId: artifact.artifactId,
      bytes: artifact.bytes,
      trustClass:
        artifact.role === "prompt"
          ? ("user-instruction" as const)
          : ("build-output" as const)
    }))
  );

  const neutral = new ExternalLocalFixtureAdapter(resolve("fixtures"));
  const cases = neutral.loadCases("evaluation/neutral-cases.json");
  if (!cases.ok) throw new Error(cases.error.message);
  const manifest = createReplayManifest({
    suiteId: "day0-5-demo",
    cases: cases.value,
    settings: {
      modelId: "recorded-offline",
      permissionDigest: canonicalJsonDigest("read-only"),
      adapterId: "recorded-fallback"
    },
    seed: 20260915,
    liveOptIn: false
  });

  const bundle = {
    formatVersion: 1,
    runId: verified.value.runId,
    storePath,
    receipt: prepared.value.receipt,
    parserReports: reports.length,
    evidenceDecision: evidenceAssessment.value.sufficiency.decision,
    sourceLink: sourceLink.value,
    delivery: {
      slices: delivery.value.slices.map((slice) => ({
        sourceId: slice.sourceId,
        startByte: slice.startByte,
        endByte: slice.endByte,
        sha256: slice.sha256
      })),
      totalBytes: delivery.value.totalBytes
    },
    modelAdvice: modelAdvice.value,
    review: {
      approvalDigest: approvedPayload.value.approval.digest,
      payloadSha256: sha256Base64Url(approvedPayload.value.bytes)
    },
    security: {
      findings: security.findings.length,
      contentTelemetry: security.contentTelemetry
    },
    handoff: handoff.value,
    evaluation: {
      kind: "synthetic-wiring-only",
      replayManifest: manifest,
      note:
        "No comparative statistics are emitted because this offline demo does not execute a model or independent recorded adapter."
    },
    integrity: verified.value.validation
  };
  const outputPath = resolve(
    outputDirectory,
    `day0-5-${verified.value.runId}.json`
  );
  await writeFile(outputPath, JSON.stringify(bundle, null, 2), "utf8");
  process.stdout.write(
    `${JSON.stringify(
      {
        outputPath,
        runId: bundle.runId,
        tokens: `${bundle.receipt.originalTokens} -> ${bundle.receipt.preparedTokens}`,
        approvalDigest: bundle.review.approvalDigest,
        plannedEvaluationTrials: bundle.evaluation.replayManifest.plans.length,
        integrity: bundle.integrity
      },
      null,
      2
    )}\n`
  );
} finally {
  store.close();
}
