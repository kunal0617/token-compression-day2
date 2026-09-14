import { createHmac, randomBytes } from "node:crypto";

import type {
  ExternalSendAuthorization,
  RedactionMapping,
  SecurityAssessment,
  SecurityFinding,
  SecurityFindingKind,
  ShareableRedactedView,
  TrustClass
} from "../contracts/security.js";
import type { ProducerMetadata } from "../contracts/providers.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import {
  deterministicUuid,
  sha256Base64Url
} from "../core/hash.js";
import { failure, success, type Result } from "../core/result.js";

function producer(): ProducerMetadata {
  const producerId = "builtin.security.local-assessment";
  const version = "1.0.0";
  return {
    producerId,
    kind: "feature-provider",
    version,
    digest: canonicalJsonDigest({
      producerId,
      version,
      contract: [
        "trust-classes",
        "high-confidence-secrets",
        "indirect-injection",
        "external-block-default",
        "no-content-telemetry",
        "random-or-hmac-redaction"
      ]
    })
  };
}

const secretPatterns: readonly {
  kind: SecurityFindingKind;
  pattern: RegExp;
}[] = [
  { kind: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { kind: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{32,255}\b/g },
  { kind: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    kind: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
  },
  {
    kind: "jwt",
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
  }
];

function byteRange(text: string, index: number, value: string) {
  const startByte = Buffer.byteLength(text.slice(0, index), "utf8");
  return {
    startByte,
    endByte: startByte + Buffer.byteLength(value, "utf8")
  };
}

export function assessSecurity(
  sources: readonly {
    readonly sourceId: string;
    readonly bytes: Buffer;
    readonly trustClass: TrustClass;
  }[]
): SecurityAssessment {
  const findings: SecurityFinding[] = [];
  for (const source of sources) {
    const text = source.bytes.toString("utf8");
    for (const item of secretPatterns) {
      const pattern = new RegExp(item.pattern.source, item.pattern.flags);
      for (const match of text.matchAll(pattern)) {
        if (match.index === undefined) continue;
        const range = byteRange(text, match.index, match[0]);
        findings.push({
          findingId: deterministicUuid(
            `${source.sourceId}:${item.kind}:${range.startByte}:${range.endByte}`
          ),
          sourceId: source.sourceId,
          trustClass: source.trustClass,
          kind: item.kind,
          ...range,
          confidence: "high",
          blocking: true,
          redactedPreview: `[REDACTED ${item.kind} ${range.endByte - range.startByte} bytes]`
        });
      }
    }
    if (
      ["external-untrusted", "build-output"].includes(source.trustClass)
    ) {
      const injection =
        /\b(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior)\s+instructions\b|<system>|system prompt|developer message/i.exec(
          text
        );
      if (injection?.index !== undefined) {
        const range = byteRange(text, injection.index, injection[0]);
        findings.push({
          findingId: deterministicUuid(
            `${source.sourceId}:indirect-prompt-injection:${range.startByte}:${range.endByte}`
          ),
          sourceId: source.sourceId,
          trustClass: source.trustClass,
          kind: "indirect-prompt-injection",
          ...range,
          confidence: "high",
          blocking: true,
          redactedPreview: "[UNTRUSTED INSTRUCTION-LIKE CONTENT]"
        });
      }
    }
  }
  const ordered = findings.sort(
    (left, right) =>
      Buffer.compare(
        Buffer.from(left.sourceId, "utf8"),
        Buffer.from(right.sourceId, "utf8")
      ) ||
      left.startByte - right.startByte ||
      left.endByte - right.endByte
  );
  const unsigned = {
    findings: ordered,
    externalLiveSendDefault: "blocked" as const,
    contentTelemetry: "disabled" as const,
    producer: producer()
  };
  return { ...unsigned, digest: canonicalJsonDigest(unsigned) };
}

function placeholder(input: {
  readonly finding: SecurityFinding;
  readonly secretBytes: Buffer;
  readonly mode: "random" | "hmac";
  readonly hmacKey?: Buffer;
}): string {
  if (input.mode === "random") {
    return `[REDACTED_${input.finding.kind}_${randomBytes(12).toString("base64url")}]`;
  }
  if (input.hmacKey === undefined || input.hmacKey.length < 32) {
    throw new TypeError("HMAC redaction requires at least 32 key bytes");
  }
  const digest = createHmac("sha256", input.hmacKey)
    .update(input.secretBytes)
    .digest("base64url")
    .slice(0, 22);
  return `[REDACTED_${input.finding.kind}_${digest}]`;
}

export function createShareableRedactedView(input: {
  readonly sourceId: string;
  readonly bytes: Buffer;
  readonly assessment: SecurityAssessment;
  readonly mode: "random" | "hmac";
  readonly hmacKey?: Buffer;
}): Result<ShareableRedactedView> {
  const findings = input.assessment.findings
    .filter(
      (finding) =>
        finding.sourceId === input.sourceId &&
        finding.kind !== "indirect-prompt-injection"
    )
    .sort((left, right) => left.startByte - right.startByte);
  if (
    input.assessment.findings.some(
      (finding) =>
        finding.sourceId === input.sourceId &&
        finding.kind === "indirect-prompt-injection"
    )
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Indirect prompt injection must be removed or reviewed, not redacted automatically"
    );
  }
  const chunks: Buffer[] = [];
  const mappings: RedactionMapping[] = [];
  let sourceOffset = 0;
  let outputOffset = 0;
  try {
    for (const finding of findings) {
      if (finding.startByte < sourceOffset || finding.endByte > input.bytes.length) {
        return failure("INTEGRITY_ERROR", "Security finding ranges overlap or exceed source");
      }
      const literal = input.bytes.subarray(sourceOffset, finding.startByte);
      chunks.push(literal);
      outputOffset += literal.length;
      const replacement = placeholder({
        finding,
        secretBytes: input.bytes.subarray(
          finding.startByte,
          finding.endByte
        ),
        mode: input.mode,
        ...(input.hmacKey === undefined ? {} : { hmacKey: input.hmacKey })
      });
      const replacementBytes = Buffer.from(replacement, "utf8");
      const outputStartByte = outputOffset;
      chunks.push(replacementBytes);
      outputOffset += replacementBytes.length;
      mappings.push({
        findingId: finding.findingId,
        sourceStartByte: finding.startByte,
        sourceEndByte: finding.endByte,
        outputStartByte,
        outputEndByte: outputOffset,
        placeholder: replacement
      });
      sourceOffset = finding.endByte;
    }
  } catch (error) {
    return failure("INVALID_ARGUMENT", "Unable to create redacted view", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  chunks.push(input.bytes.subarray(sourceOffset));
  const bytes = Buffer.concat(chunks);
  const unsigned = {
    sourceId: input.sourceId,
    sourceSha256: sha256Base64Url(input.bytes),
    sha256: sha256Base64Url(bytes),
    mappings,
    mode: input.mode
  };
  return success({
    ...unsigned,
    bytes,
    digest: canonicalJsonDigest(unsigned)
  });
}

export function authorizeExternalSend(input: {
  readonly payload: Buffer;
  readonly assessment: SecurityAssessment;
  readonly explicitApproval: boolean;
  readonly redactedView?: ShareableRedactedView;
}): Result<ExternalSendAuthorization> {
  if (!input.explicitApproval) {
    return failure(
      "INVALID_ARGUMENT",
      "External live send is blocked by default"
    );
  }
  const payloadSha256 = sha256Base64Url(input.payload);
  const blocking = input.assessment.findings.filter(
    (finding) => finding.blocking
  );
  if (blocking.length > 0) {
    if (
      input.redactedView === undefined ||
      input.redactedView.sha256 !== payloadSha256 ||
      input.redactedView.mappings.length <
        blocking.filter(
          (finding) => finding.kind !== "indirect-prompt-injection"
        ).length ||
      blocking.some(
        (finding) => finding.kind === "indirect-prompt-injection"
      )
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Blocking security findings require a reviewed redacted payload"
      );
    }
  }
  const unsigned = {
    explicitApproval: true as const,
    payloadSha256,
    securityAssessmentDigest: input.assessment.digest,
    ...(input.redactedView === undefined
      ? {}
      : { redactedViewDigest: input.redactedView.digest })
  };
  return success({ ...unsigned, digest: canonicalJsonDigest(unsigned) });
}

export function validateExternalSendAuthorization(input: {
  readonly payload: Buffer;
  readonly assessment: SecurityAssessment;
  readonly authorization: ExternalSendAuthorization;
}): Result<void> {
  const unsigned = {
    explicitApproval: input.authorization.explicitApproval,
    payloadSha256: input.authorization.payloadSha256,
    securityAssessmentDigest:
      input.authorization.securityAssessmentDigest,
    ...(input.authorization.redactedViewDigest === undefined
      ? {}
      : { redactedViewDigest: input.authorization.redactedViewDigest })
  };
  if (
    input.authorization.digest !== canonicalJsonDigest(unsigned) ||
    input.authorization.payloadSha256 !== sha256Base64Url(input.payload) ||
    input.authorization.securityAssessmentDigest !== input.assessment.digest
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "External send authorization does not bind payload and security assessment"
    );
  }
  return success(undefined);
}

export const securityAssessmentProducer = Object.freeze({
  metadata: producer()
});

