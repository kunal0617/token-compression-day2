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

function byteRange(index: number, value: string) {
  return {
    startByte: index,
    endByte: index + value.length
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
    const byteText = source.bytes.toString("latin1");
    for (const item of secretPatterns) {
      const pattern = new RegExp(item.pattern.source, item.pattern.flags);
      for (const match of byteText.matchAll(pattern)) {
        if (match.index === undefined) continue;
        const range = byteRange(match.index, match[0]);
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
          byteText
        );
      if (injection?.index !== undefined) {
        const range = byteRange(injection.index, injection[0]);
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
  const sourceIdentities = sources
    .map((source) => ({
      sourceId: source.sourceId,
      trustClass: source.trustClass,
      sha256: sha256Base64Url(source.bytes),
      byteLength: source.bytes.length
    }))
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.sourceId, "utf8"),
        Buffer.from(right.sourceId, "utf8")
      )
    );
  const unsigned = {
    sources: sourceIdentities,
    findings: ordered,
    externalLiveSendDefault: "blocked" as const,
    contentTelemetry: "disabled" as const,
    producer: producer()
  };
  return { ...unsigned, digest: canonicalJsonDigest(unsigned) };
}

export function validateSecurityAssessment(input: {
  readonly assessment: SecurityAssessment;
  readonly sources: readonly {
    readonly sourceId: string;
    readonly bytes: Buffer;
    readonly trustClass: TrustClass;
  }[];
}): Result<void> {
  const recomputed = assessSecurity(input.sources);
  return canonicalJsonDigest(input.assessment) ===
      canonicalJsonDigest(recomputed) &&
    input.assessment.digest === recomputed.digest
    ? success(undefined)
    : failure(
        "INTEGRITY_ERROR",
        "Security assessment does not match assessed source bytes"
      );
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
  const assessedSource = input.assessment.sources.find(
    (source) => source.sourceId === input.sourceId
  );
  if (
    assessedSource === undefined ||
    assessedSource.sha256 !== sha256Base64Url(input.bytes) ||
    assessedSource.byteLength !== input.bytes.length
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Redacted source does not match the security assessment"
    );
  }
  const assessment = validateSecurityAssessment({
    assessment: input.assessment,
    sources: [
      {
        sourceId: assessedSource.sourceId,
        bytes: input.bytes,
        trustClass: assessedSource.trustClass
      }
    ]
  });
  if (!assessment.ok) return assessment;
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

export function validateShareableRedactedView(input: {
  readonly sourceBytes: Buffer;
  readonly assessment: SecurityAssessment;
  readonly view: ShareableRedactedView;
  readonly hmacKey?: Buffer;
}): Result<void> {
  const source = input.assessment.sources.find(
    (item) => item.sourceId === input.view.sourceId
  );
  if (
    source === undefined ||
    source.sha256 !== sha256Base64Url(input.sourceBytes) ||
    source.byteLength !== input.sourceBytes.length
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Redacted view source does not match the security assessment"
    );
  }
  const findings = input.assessment.findings
    .filter(
      (finding) =>
        finding.sourceId === input.view.sourceId &&
        finding.kind !== "indirect-prompt-injection"
    )
    .sort((left, right) => left.startByte - right.startByte);
  if (
    findings.length !== input.view.mappings.length ||
    input.view.sourceSha256 !== source.sha256 ||
    input.view.sha256 !== sha256Base64Url(input.view.bytes)
  ) {
    return failure("INTEGRITY_ERROR", "Redacted view metadata is inconsistent");
  }
  const chunks: Buffer[] = [];
  let sourceOffset = 0;
  let outputOffset = 0;
  for (const [index, finding] of findings.entries()) {
    const mapping = input.view.mappings[index];
    if (
      mapping === undefined ||
      mapping.findingId !== finding.findingId ||
      mapping.sourceStartByte !== finding.startByte ||
      mapping.sourceEndByte !== finding.endByte ||
      mapping.outputStartByte < outputOffset
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Redacted view mappings are not one-to-one and ordered"
      );
    }
    const literal = input.sourceBytes.subarray(
      sourceOffset,
      finding.startByte
    );
    chunks.push(literal);
    outputOffset += literal.length;
    if (mapping.outputStartByte !== outputOffset) {
      return failure("INTEGRITY_ERROR", "Redacted output offset is invalid");
    }
    const replacement = Buffer.from(mapping.placeholder, "utf8");
    if (input.view.mode === "random") {
      if (
        !new RegExp(
          `^\\[REDACTED_${finding.kind}_[A-Za-z0-9_-]{16}\\]$`
        ).test(mapping.placeholder)
      ) {
        return failure(
          "INTEGRITY_ERROR",
          "Random redaction placeholder is invalid"
        );
      }
    } else {
      if (input.hmacKey === undefined || input.hmacKey.length < 32) {
        return failure(
          "INTEGRITY_ERROR",
          "HMAC redaction validation requires the original key"
        );
      }
      const expected = placeholder({
        finding,
        secretBytes: input.sourceBytes.subarray(
          finding.startByte,
          finding.endByte
        ),
        mode: "hmac",
        hmacKey: input.hmacKey
      });
      if (mapping.placeholder !== expected) {
        return failure(
          "INTEGRITY_ERROR",
          "HMAC redaction placeholder is invalid"
        );
      }
    }
    chunks.push(replacement);
    outputOffset += replacement.length;
    if (mapping.outputEndByte !== outputOffset) {
      return failure("INTEGRITY_ERROR", "Redacted placeholder length is invalid");
    }
    sourceOffset = finding.endByte;
  }
  chunks.push(input.sourceBytes.subarray(sourceOffset));
  const reconstructedView = Buffer.concat(chunks);
  const unsigned = {
    sourceId: input.view.sourceId,
    sourceSha256: input.view.sourceSha256,
    sha256: input.view.sha256,
    mappings: input.view.mappings,
    mode: input.view.mode
  };
  if (
    !reconstructedView.equals(input.view.bytes) ||
    input.view.digest !== canonicalJsonDigest(unsigned)
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Redacted view bytes or digest are invalid"
    );
  }
  return success(undefined);
}

export function authorizeExternalSend(input: {
  readonly payload: Buffer;
  readonly assessment: SecurityAssessment;
  readonly explicitApproval: boolean;
  readonly redactedView?: ShareableRedactedView;
  readonly assessedSource: {
    readonly sourceId: string;
    readonly bytes: Buffer;
    readonly trustClass: TrustClass;
  };
  readonly redactionHmacKey?: Buffer;
}): Result<ExternalSendAuthorization> {
  if (!input.explicitApproval) {
    return failure(
      "INVALID_ARGUMENT",
      "External live send is blocked by default"
    );
  }
  const payloadSha256 = sha256Base64Url(input.payload);
  const boundAssessment = validateSecurityAssessment({
    assessment: input.assessment,
    sources: [input.assessedSource]
  });
  if (!boundAssessment.ok) return boundAssessment;
  if (input.redactedView === undefined) {
    if (
      sha256Base64Url(input.assessedSource.bytes) !== payloadSha256 ||
      input.assessedSource.bytes.length !== input.payload.length
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Security assessment is not bound to the outbound payload"
      );
    }
  } else {
    const view = validateShareableRedactedView({
      sourceBytes: input.assessedSource.bytes,
      assessment: input.assessment,
      view: input.redactedView,
      ...(input.redactionHmacKey === undefined
        ? {}
        : { hmacKey: input.redactionHmacKey })
    });
    if (!view.ok || input.redactedView.sha256 !== payloadSha256) {
      return failure(
        "INTEGRITY_ERROR",
        "Outbound payload is not the validated redacted view"
      );
    }
  }
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
  readonly assessedSource: {
    readonly sourceId: string;
    readonly bytes: Buffer;
    readonly trustClass: TrustClass;
  };
  readonly redactedView?: ShareableRedactedView;
  readonly redactionHmacKey?: Buffer;
}): Result<void> {
  const boundAssessment = validateSecurityAssessment({
    assessment: input.assessment,
    sources: [input.assessedSource]
  });
  if (!boundAssessment.ok) return boundAssessment;
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
    input.authorization.explicitApproval !== true ||
    input.authorization.digest !== canonicalJsonDigest(unsigned) ||
    input.authorization.payloadSha256 !== sha256Base64Url(input.payload) ||
    input.authorization.securityAssessmentDigest !== input.assessment.digest
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "External send authorization does not bind payload and security assessment"
    );
  }
  if (input.redactedView === undefined) {
    if (
      input.assessment.findings.some((finding) => finding.blocking) ||
      sha256Base64Url(input.assessedSource.bytes) !==
        input.authorization.payloadSha256 ||
      input.assessedSource.bytes.length !== input.payload.length
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Authorization assessment is not bound to safe outbound bytes"
      );
    }
  } else {
    if (input.authorization.redactedViewDigest !== input.redactedView.digest) {
      return failure("INTEGRITY_ERROR", "Redacted authorization is incomplete");
    }
    const assessment = validateSecurityAssessment({
      assessment: input.assessment,
      sources: [input.assessedSource]
    });
    if (!assessment.ok) return assessment;
    const view = validateShareableRedactedView({
      sourceBytes: input.assessedSource.bytes,
      assessment: input.assessment,
      view: input.redactedView,
      ...(input.redactionHmacKey === undefined
        ? {}
        : { hmacKey: input.redactionHmacKey })
    });
    if (
      !view.ok ||
      input.redactedView.sha256 !== sha256Base64Url(input.payload) ||
      input.assessment.findings.some(
        (finding) =>
          finding.blocking &&
          finding.kind === "indirect-prompt-injection"
      )
    ) {
      return failure("INTEGRITY_ERROR", "Redacted authorization view is invalid");
    }
  }
  return success(undefined);
}

export const securityAssessmentProducer = Object.freeze({
  metadata: producer()
});
