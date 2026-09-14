import type {
  ArtifactClassification,
  ContextReceipt,
  EvidenceSpan,
  IntentClassification,
  OmissionRecord,
  RunOutcome,
  TokenMeasurement,
  TransformReason
} from "../contracts/types.js";

const transformReasons: readonly TransformReason[] = [
  "exact-consecutive-repetition",
  "exact-nonconsecutive-repetition",
  "success-chatter",
  "scoped-boilerplate",
  "volatile-template"
];

export function buildReceipt(input: {
  readonly runId: string;
  readonly classifications: readonly ArtifactClassification[];
  readonly intent: IntentClassification;
  readonly outcome: RunOutcome;
  readonly originalBytes: number;
  readonly preparedBytes: number;
  readonly tokens: TokenMeasurement;
  readonly evidence: readonly EvidenceSpan[];
  readonly omissions: readonly OmissionRecord[];
  readonly warnings: readonly string[];
}): ContextReceipt {
  const transformations = Object.fromEntries(
    transformReasons.map((reason) => [
      reason,
      input.omissions.filter((omission) => omission.reason === reason).length
    ])
  ) as Readonly<Record<TransformReason, number>>;
  const tokenReductionPercent =
    input.tokens.originalTokens === 0
      ? 0
      : ((input.tokens.originalTokens - input.tokens.preparedTokens) /
          input.tokens.originalTokens) *
        100;

  return {
    runId: input.runId,
    readiness: "ready",
    artifactClassifications: input.classifications,
    intent: input.intent,
    outcome: input.outcome,
    originalBytes: input.originalBytes,
    preparedBytes: input.preparedBytes,
    originalTokens: input.tokens.originalTokens,
    preparedTokens: input.tokens.preparedTokens,
    tokenReductionPercent,
    protectedEvidence: input.evidence.map((item) => ({
      evidenceId: item.evidenceId,
      occurrenceId: item.occurrenceId,
      kind: item.kind,
      artifactId: item.artifactId,
      startByte: item.startByte,
      endByte: item.endByte
    })),
    transformations,
    handles: input.omissions.map((omission) => omission.handle),
    warnings: input.warnings,
    integrity: "verified",
    reconstruction: "byte-identical"
  };
}

