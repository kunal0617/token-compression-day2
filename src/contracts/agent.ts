import type {
  ApprovedReviewPayload
} from "./tui.js";
import type { PermissionEnvelope } from "./approval.js";
import type { DeliverySlice } from "./source-scope.js";
import type { EvidenceSpan } from "./types.js";
import type { ProducerMetadata } from "./providers.js";
import type { Result } from "../core/result.js";
import type {
  ExternalSendAuthorization,
  SecurityAssessment,
  ShareableRedactedView,
  TrustClass
} from "./security.js";

export interface AgentReadScope {
  readonly runId: string;
  readonly evidence: readonly {
    readonly span: EvidenceSpan;
    readonly bytes: Buffer;
  }[];
  readonly sources: readonly DeliverySlice[];
}

export interface AgentRunScopeAuthority {
  issueReview(input: {
    readonly runId: string;
    readonly approved: Omit<ApprovedReviewPayload, "authorityToken">;
    readonly readScope: AgentReadScope;
  }): Result<string>;
  validate(request: ApprovedAgentSendRequest): Result<void>;
}

export interface ApprovedAgentSendRequest {
  readonly runId: string;
  readonly approved: ApprovedReviewPayload;
  readonly readScope: AgentReadScope;
  readonly security: {
    readonly assessment: SecurityAssessment;
    readonly authorization: ExternalSendAuthorization;
    readonly assessedSource: {
      readonly sourceId: string;
      readonly trustClass: TrustClass;
      readonly bytes: Buffer;
    };
    readonly redactedView?: ShareableRedactedView;
    readonly redactionHmacKey?: Buffer;
  };
  readonly timeoutMs: number;
}

export interface AgentEventRecord {
  readonly type: string;
  readonly timestamp: string;
}

export interface AgentSendReceipt {
  readonly runId: string;
  readonly sessionId: string;
  readonly messageId?: string;
  readonly modelId?: string;
  readonly applicationPayloadSha256: string;
  readonly applicationSettingsDigest: string;
  readonly permissions: PermissionEnvelope;
  readonly events: readonly AgentEventRecord[];
  readonly providerUsage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly modelIds: readonly string[];
  };
  readonly responseText?: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly producer: ProducerMetadata;
}

export interface ModelCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
}
