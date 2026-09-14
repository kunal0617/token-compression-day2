import type { ProducerMetadata } from "./providers.js";

export type TrustClass =
  | "user-instruction"
  | "repository-source"
  | "build-output"
  | "external-untrusted"
  | "generated";

export type SecurityFindingKind =
  | "github-token"
  | "openai-key"
  | "aws-access-key"
  | "private-key"
  | "jwt"
  | "indirect-prompt-injection";

export interface SecurityFinding {
  readonly findingId: string;
  readonly sourceId: string;
  readonly trustClass: TrustClass;
  readonly kind: SecurityFindingKind;
  readonly startByte: number;
  readonly endByte: number;
  readonly confidence: "high";
  readonly blocking: boolean;
  readonly redactedPreview: string;
}

export interface SecurityAssessment {
  readonly findings: readonly SecurityFinding[];
  readonly externalLiveSendDefault: "blocked";
  readonly contentTelemetry: "disabled";
  readonly digest: string;
  readonly producer: ProducerMetadata;
}

export interface RedactionMapping {
  readonly findingId: string;
  readonly sourceStartByte: number;
  readonly sourceEndByte: number;
  readonly outputStartByte: number;
  readonly outputEndByte: number;
  readonly placeholder: string;
}

export interface ShareableRedactedView {
  readonly sourceId: string;
  readonly sourceSha256: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly mappings: readonly RedactionMapping[];
  readonly mode: "random" | "hmac";
  readonly digest: string;
}

export interface ExternalSendAuthorization {
  readonly explicitApproval: true;
  readonly payloadSha256: string;
  readonly securityAssessmentDigest: string;
  readonly redactedViewDigest?: string;
  readonly digest: string;
}

