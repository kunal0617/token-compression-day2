import { z } from "zod";

const byteIndex = z.number().int().nonnegative();
const sha256Base64UrlSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "Expected full SHA-256 base64url digest");
const byteRangeSchema = z
  .object({
    startByte: byteIndex,
    endByte: byteIndex
  })
  .strict()
  .refine((range) => range.endByte >= range.startByte, {
    message: "endByte must be greater than or equal to startByte"
  });

const artifactSourceSchema = z
  .object({
    kind: z.enum(["file", "pasted"]),
    label: z.string().min(1),
    requestedPath: z.string().min(1).optional(),
    canonicalPath: z.string().min(1).optional()
  })
  .strict();

const artifactClassificationSchema = z
  .object({
    artifactId: z.string().min(1),
    kind: z.enum([
      "prompt",
      "test-log",
      "compiler-diagnostics",
      "stack-trace",
      "diff",
      "source",
      "generic-log",
      "text"
    ]),
    confidence: z.number().min(0).max(1),
    uncertain: z.boolean(),
    reasons: z.array(z.string())
  })
  .strict();

const intentClassificationSchema = z
  .object({
    kind: z.enum([
      "debug",
      "fix",
      "build",
      "test",
      "review",
      "explain",
      "general"
    ]),
    confidence: z.number().min(0).max(1),
    uncertain: z.boolean(),
    reasons: z.array(z.string())
  })
  .strict();

const evidenceSchema = byteRangeSchema
  .extend({
    evidenceId: z.string().min(1),
    occurrenceId: z.string().min(1),
    artifactId: z.string().min(1),
    kind: z.enum([
      "failing-test",
      "assertion-block",
      "expected-value",
      "actual-value",
      "exception-chain",
      "exception",
      "stack-frame",
      "compiler-diagnostic",
      "command",
      "exit-code",
      "source-location",
      "path",
      "identifier",
      "version",
      "timestamp",
      "final-summary",
      "correlation-id",
      "unknown-diagnostic"
    ]),
    sha256: sha256Base64UrlSchema,
    textPreview: z.string(),
    reasons: z.array(z.string()),
    mandatoryInline: z.boolean(),
    protectionReasons: z.array(z.string())
  })
  .strict();

const protectedRangeSchema = byteRangeSchema
  .extend({
    artifactId: z.string().min(1),
    reasons: z.array(z.string()),
    evidenceIds: z.array(z.string())
  })
  .strict();

const transformReasonSchema = z.enum([
  "exact-consecutive-repetition",
  "exact-nonconsecutive-repetition",
  "success-chatter",
  "scoped-boilerplate",
  "volatile-template"
]);

const plannedTransformSchema = byteRangeSchema
  .extend({
    proposalId: z.string().min(1),
    artifactId: z.string().min(1),
    reason: transformReasonSchema,
    priority: z.number().int(),
    sourceCount: z.number().int().positive(),
    metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    occurrenceId: z.string().min(1),
    omittedSha256: sha256Base64UrlSchema,
    omittedByteLength: z.number().int().positive(),
    handle: z.string().min(1),
    marker: z.string().min(1)
  })
  .strict();

const omissionSchema = byteRangeSchema
  .extend({
    occurrenceId: z.string().min(1),
    artifactId: z.string().min(1),
    handle: z.string().min(1),
    sha256: sha256Base64UrlSchema,
    byteLength: z.number().int().positive(),
    reason: transformReasonSchema,
    marker: z.string().min(1),
    sourceCount: z.number().int().positive()
  })
  .strict();

const outputMappingSchema = z
  .object({
    mappingId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    artifactId: z.string().min(1).optional(),
    sourceStartByte: byteIndex.optional(),
    sourceEndByte: byteIndex.optional(),
    outputStartByte: byteIndex,
    outputEndByte: byteIndex,
    kind: z.enum(["synthetic", "literal", "omission"]),
    handle: z.string().min(1).optional()
  })
  .strict()
  .refine((mapping) => mapping.outputEndByte >= mapping.outputStartByte, {
    message: "outputEndByte must be greater than or equal to outputStartByte"
  });

const evidenceMappingSchema = z
  .object({
    evidenceId: z.string().min(1),
    occurrenceId: z.string().min(1),
    artifactId: z.string().min(1),
    sourceStartByte: byteIndex,
    sourceEndByte: byteIndex,
    outputStartByte: byteIndex,
    outputEndByte: byteIndex,
    sha256: sha256Base64UrlSchema
  })
  .strict();

const artifactManifestSchema = z
  .object({
    artifactId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    role: z.enum(["prompt", "context"]),
    source: artifactSourceSchema,
    byteLength: z.number().int().nonnegative(),
    sha256: sha256Base64UrlSchema,
    utf8: z.enum(["valid", "invalid"]),
    hasBom: z.boolean(),
    newlineStyle: z.enum(["none", "lf", "crlf", "cr", "mixed"]),
    hasAnsi: z.boolean(),
    completeness: z.enum(["complete", "truncated", "unknown"]),
    completenessReason: z.string().min(1),
    outcome: z.enum(["green", "red", "unknown"]),
    classification: artifactClassificationSchema
  })
  .strict();

const tokenMeasurementSchema = z
  .object({
    encoding: z.literal("o200k_base"),
    kind: z.literal("actual"),
    originalTokens: z.number().int().nonnegative(),
    preparedTokens: z.number().int().nonnegative()
  })
  .strict();

export const canonicalManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    runId: z.string().min(1),
    createdAt: z.string().datetime(),
    artifacts: z.array(artifactManifestSchema),
    intent: intentClassificationSchema,
    outcome: z.enum(["green", "red", "unknown"]),
    policy: z
      .object({
        nearbySegments: z.number().int().nonnegative()
      })
      .strict(),
    evidence: z.array(evidenceSchema),
    protectedRanges: z.array(protectedRangeSchema),
    transforms: z.array(plannedTransformSchema),
    omissions: z.array(omissionSchema),
    outputMappings: z.array(outputMappingSchema),
    evidenceMappings: z.array(evidenceMappingSchema),
    compactSha256: sha256Base64UrlSchema,
    compactByteLength: z.number().int().nonnegative(),
    originalByteLength: z.number().int().nonnegative(),
    tokenizer: tokenMeasurementSchema
  })
  .strict();

export const contextReceiptSchema = z
  .object({
    runId: z.string().min(1),
    readiness: z.enum(["ready", "failed"]),
    artifactClassifications: z.array(artifactClassificationSchema),
    intent: intentClassificationSchema,
    outcome: z.enum(["green", "red", "unknown"]),
    originalBytes: z.number().int().nonnegative(),
    preparedBytes: z.number().int().nonnegative(),
    originalTokens: z.number().int().nonnegative(),
    preparedTokens: z.number().int().nonnegative(),
    tokenReductionPercent: z.number().finite(),
    protectedEvidence: z.array(
      z
        .object({
          evidenceId: z.string().min(1),
          occurrenceId: z.string().min(1),
          kind: z.enum([
            "failing-test",
            "assertion-block",
            "expected-value",
            "actual-value",
            "exception-chain",
            "exception",
            "stack-frame",
            "compiler-diagnostic",
            "command",
            "exit-code",
            "source-location",
            "path",
            "identifier",
            "version",
            "timestamp",
            "final-summary",
            "correlation-id",
            "unknown-diagnostic"
          ]),
          artifactId: z.string().min(1),
          startByte: byteIndex,
          endByte: byteIndex
        })
        .strict()
    ),
    transformations: z
      .object({
        "exact-consecutive-repetition": z.number().int().nonnegative(),
        "exact-nonconsecutive-repetition": z.number().int().nonnegative(),
        "success-chatter": z.number().int().nonnegative(),
        "scoped-boilerplate": z.number().int().nonnegative(),
        "volatile-template": z.number().int().nonnegative()
      })
      .strict(),
    handles: z.array(z.string().min(1)),
    warnings: z.array(z.string()),
    integrity: z.literal("verified"),
    reconstruction: z.literal("byte-identical")
  })
  .strict();
