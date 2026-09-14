import { z } from "zod";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type {
  AgentEventRecord,
  AgentReadScope,
  AgentRunScopeAuthority,
  AgentSendReceipt,
  ApprovedAgentSendRequest,
  ModelCatalogEntry
} from "../contracts/agent.js";
import type { ProducerMetadata } from "../contracts/providers.js";
import { validateApproval } from "../approval/review.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import { sha256Base64Url } from "../core/hash.js";
import { failure, success, type Result } from "../core/result.js";
import {
  assessSecurity,
  validateExternalSendAuthorization
} from "../security/security.js";
import { agentReadScopeDigest } from "../core/read-scope.js";
import { builtinRuntime } from "../registry/builtins.js";

export interface SdkEvent {
  readonly type?: string;
  readonly timestamp?: string | Date;
  readonly data?: unknown;
}

export interface SdkSessionLike {
  readonly sessionId: string;
  on(handler: (event: SdkEvent) => void): () => void;
  sendAndWait(
    options: { prompt: string },
    timeout?: number
  ): Promise<SdkEvent | undefined>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface SdkClientLike {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  createSession(config: Readonly<Record<string, unknown>>): Promise<SdkSessionLike>;
  resumeSession(
    sessionId: string,
    config: Readonly<Record<string, unknown>>
  ): Promise<SdkSessionLike>;
  listModels(): Promise<
    readonly {
      id: string;
      name: string;
      capabilities?: Readonly<Record<string, unknown>>;
      policy?: Readonly<Record<string, unknown>>;
      billing?: Readonly<Record<string, unknown>>;
      supportedReasoningEfforts?: readonly string[];
      defaultReasoningEffort?: string;
    }[]
  >;
}

export interface SdkModuleLike {
  readonly CopilotClient: new (
    options?: Readonly<Record<string, unknown>>
  ) => SdkClientLike;
  defineTool<T>(
    name: string,
    config: {
      description: string;
      parameters: z.ZodType<T>;
      handler: (args: T) => unknown;
      skipPermission?: boolean;
    }
  ): unknown;
}

export type CopilotSdkLoader = () => Promise<SdkModuleLike>;

const defaultLoader: CopilotSdkLoader = async () =>
  (await import("@github/copilot-sdk")) as unknown as SdkModuleLike;

function metadata(): ProducerMetadata {
  const producerId = "optional.github.copilot-sdk-adapter";
  const version = "1.0.0";
  return {
    producerId,
    kind: "coding-agent",
    version,
    digest: canonicalJsonDigest({
      producerId,
      version,
      contract: [
        "approval-required",
        "empty-mode",
        "run-scoped-reads",
        "explicit-permissions",
        "timeout-abort",
        "session-reuse",
        "dynamic-catalog"
      ]
    })
  };
}

function deepFreeze<T>(value: T): T {
  if (
    value !== null &&
    typeof value === "object" &&
    !ArrayBuffer.isView(value)
  ) {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

function snapshotRequest(
  input: ApprovedAgentSendRequest
): ApprovedAgentSendRequest {
  const approvedBytes = Buffer.from(input.approved.bytes);
  const assessedBytes = Buffer.from(input.security.assessedSource.bytes);
  const snapshot: ApprovedAgentSendRequest = {
    runId: input.runId,
    approved: {
      bytes: approvedBytes,
      subject: structuredClone(input.approved.subject),
      approval: structuredClone(input.approved.approval)
    },
    readScope: {
      runId: input.readScope.runId,
      evidence: input.readScope.evidence.map((item) => ({
        span: structuredClone(item.span),
        bytes: Buffer.from(item.bytes)
      })),
      sources: input.readScope.sources.map((source) => ({
        ...structuredClone({
          sourceId: source.sourceId,
          path: source.path,
          startByte: source.startByte,
          endByte: source.endByte,
          sha256: source.sha256,
          unitIds: source.unitIds
        }),
        bytes: Buffer.from(source.bytes)
      }))
    },
    security: {
      assessment: structuredClone(input.security.assessment),
      authorization: structuredClone(input.security.authorization),
      assessedSource: {
        sourceId: input.security.assessedSource.sourceId,
        trustClass: input.security.assessedSource.trustClass,
        bytes: assessedBytes
      },
      ...(input.security.redactedView === undefined
        ? {}
        : {
            redactedView: {
              ...structuredClone({
                sourceId: input.security.redactedView.sourceId,
                sourceSha256: input.security.redactedView.sourceSha256,
                sha256: input.security.redactedView.sha256,
                mappings: input.security.redactedView.mappings,
                mode: input.security.redactedView.mode,
                digest: input.security.redactedView.digest
              }),
              bytes: Buffer.from(input.security.redactedView.bytes)
            }
          }),
      ...(input.security.redactionHmacKey === undefined
        ? {}
        : {
            redactionHmacKey: Buffer.from(
              input.security.redactionHmacKey
            )
          })
    },
    timeoutMs: input.timeoutMs
  };
  return deepFreeze(snapshot);
}

function nestedRecord(
  value: unknown,
  key: string
): Readonly<Record<string, unknown>> | undefined {
  if (
    value !== null &&
    typeof value === "object" &&
    key in value &&
    (value as Record<string, unknown>)[key] !== null &&
    typeof (value as Record<string, unknown>)[key] === "object"
  ) {
    return (value as Record<string, unknown>)[key] as Readonly<
      Record<string, unknown>
    >;
  }
  return undefined;
}

function normalizeModel(model: {
  id: string;
  name: string;
  capabilities?: Readonly<Record<string, unknown>>;
  policy?: Readonly<Record<string, unknown>>;
  billing?: Readonly<Record<string, unknown>>;
  supportedReasoningEfforts?: readonly string[];
  defaultReasoningEffort?: string;
}): ModelCatalogEntry {
  const supports = nestedRecord(model.capabilities, "supports");
  const limits = nestedRecord(model.capabilities, "limits");
  return {
    id: model.id,
    name: model.name,
    capabilities: {
      supportsVision:
        typeof supports?.vision === "boolean" ? supports.vision : undefined,
      supportsReasoning:
        typeof supports?.reasoningEffort === "boolean"
          ? supports.reasoningEffort
          : undefined,
      maxPromptTokens:
        typeof limits?.max_prompt_tokens === "number"
          ? limits.max_prompt_tokens
          : undefined,
      contextWindow:
        typeof limits?.max_context_window_tokens === "number"
          ? limits.max_context_window_tokens
          : undefined,
      supportedReasoningEfforts: model.supportedReasoningEfforts ?? [],
      defaultReasoningEffort: model.defaultReasoningEffort,
      policyState:
        typeof model.policy?.state === "string"
          ? model.policy.state
          : undefined,
      billingMultiplier:
        typeof model.billing?.multiplier === "number"
          ? model.billing.multiplier
          : undefined
    }
  };
}

function permissionHandler(
  permissions: ApprovedAgentSendRequest["approved"]["subject"]["target"]["permissions"]
) {
  return (request: {
    readonly kind?: string;
    readonly managedApprovalRequired?: boolean;
  }) => {
    if (request.managedApprovalRequired === true) {
      return {
        kind: "reject",
        feedback:
          "Managed policy requires an explicit human permission decision"
      } as const;
    }
    const approved =
      (request.kind === "shell" && permissions.shell) ||
      (request.kind === "write" && permissions.fileWrite) ||
      ((request.kind === "url" || request.kind === "mcp") &&
        permissions.network);
    return approved
      ? ({ kind: "approved" } as const)
      : ({
          kind: "reject",
          feedback: `Permission ${request.kind ?? "unknown"} is outside the approved envelope`
        } as const);
  };
}

function secureToolResult(
  sourceId: string,
  bytes: Buffer,
  trustClass: "build-output" | "repository-source"
) {
  const assessment = assessSecurity([{ sourceId, bytes, trustClass }]);
  if (assessment.findings.some((finding) => finding.blocking)) {
    throw new Error(
      "Approved read contains blocking security findings and cannot be sent"
    );
  }
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error("Approved read is not exact UTF-8");
  }
  return {
    text,
    bytesBase64: bytes.toString("base64"),
    byteLength: bytes.length,
    sha256: sha256Base64Url(bytes),
    securityAssessmentDigest: assessment.digest
  };
}

function scopedToolsForPermissions(
  sdk: SdkModuleLike,
  scope: AgentReadScope,
  permissions: ApprovedAgentSendRequest["approved"]["subject"]["target"]["permissions"]
): unknown[] {
  const evidenceSchema = z
    .object({
      runId: z.string(),
      evidenceId: z.string()
    })
    .strict();
  const sourceSchema = z
    .object({
      runId: z.string(),
      sourceId: z.string(),
      startByte: z.number().int().nonnegative(),
      endByte: z.number().int().nonnegative()
    })
    .strict();
  const tools: unknown[] = [];
  if (permissions.evidenceRead) {
    tools.push(
      sdk.defineTool("evidence_read", {
      description: "Read one approved evidence occurrence from this run",
      parameters: evidenceSchema,
      skipPermission: true,
      handler: (args) => {
        if (!permissions.evidenceRead) {
          throw new Error("Evidence read permission is not approved");
        }
        if (args.runId !== scope.runId) {
          throw new Error("Cross-run evidence read rejected");
        }
        const evidence = scope.evidence.find(
          (item) => item.span.evidenceId === args.evidenceId
        );
        if (evidence === undefined) {
          throw new Error("Unapproved evidence occurrence");
        }
        const secured = secureToolResult(
          `evidence:${evidence.span.evidenceId}`,
          evidence.bytes,
          "build-output"
        );
        return {
          evidenceId: evidence.span.evidenceId,
          artifactId: evidence.span.artifactId,
          startByte: evidence.span.startByte,
          endByte: evidence.span.endByte,
          ...secured
        };
      }
      })
    );
  }
  if (permissions.sourceRead) {
    tools.push(
      sdk.defineTool("source_read", {
      description: "Read an approved exact source range from this run",
      parameters: sourceSchema,
      skipPermission: true,
      handler: (args) => {
        if (!permissions.sourceRead) {
          throw new Error("Source read permission is not approved");
        }
        if (args.runId !== scope.runId || args.endByte < args.startByte) {
          throw new Error("Cross-run or invalid source read rejected");
        }
        const source = scope.sources.find(
          (item) =>
            item.sourceId === args.sourceId &&
            item.startByte <= args.startByte &&
            item.endByte >= args.endByte
        );
        if (source === undefined) {
          throw new Error("Unapproved source range");
        }
        const relativeStart = args.startByte - source.startByte;
        const relativeEnd = args.endByte - source.startByte;
        const bytes = source.bytes.subarray(relativeStart, relativeEnd);
        const secured = secureToolResult(
          `source:${source.sourceId}:${args.startByte}:${args.endByte}`,
          bytes,
          "repository-source"
        );
        return {
          sourceId: source.sourceId,
          startByte: args.startByte,
          endByte: args.endByte,
          ...secured
        };
      }
      })
    );
  }
  return tools;
}

function eventRecord(event: SdkEvent): AgentEventRecord {
  return {
    type: event.type ?? "unknown",
    timestamp:
      event.timestamp instanceof Date
        ? event.timestamp.toISOString()
        : event.timestamp ?? new Date().toISOString()
  };
}

function assistantText(event: SdkEvent | undefined): string | undefined {
  if (
    event?.data !== null &&
    typeof event?.data === "object" &&
    "content" in event.data &&
    typeof event.data.content === "string"
  ) {
    return event.data.content;
  }
  return undefined;
}

export class OptionalCopilotSdkAdapter {
  readonly metadata = metadata();
  readonly #loader: CopilotSdkLoader;
  readonly #authority: AgentRunScopeAuthority | undefined;
  #client: SdkClientLike | undefined;
  #clientWorkingDirectory: string | undefined;
  #sdk: SdkModuleLike | undefined;
  readonly #sessions = new Map<
    string,
    {
      readonly session: SdkSessionLike;
      readonly bindingDigest: string;
      readonly runId: string;
      readonly modelId: string;
      readonly workingDirectory: string;
    }
  >();

  constructor(
    loader: CopilotSdkLoader = defaultLoader,
    authority?: AgentRunScopeAuthority
  ) {
    this.#loader = loader;
    this.#authority = authority;
  }

  async #ensureClient(workingDirectory: string): Promise<SdkClientLike> {
    const normalizedWorkingDirectory = resolve(workingDirectory);
    if (this.#client !== undefined) {
      if (this.#clientWorkingDirectory !== normalizedWorkingDirectory) {
        throw new Error(
          "Copilot adapter is already bound to another working directory; close it before changing directories"
        );
      }
      return this.#client;
    }
    this.#sdk = await this.#loader();
    const baseDirectory = resolve(
      normalizedWorkingDirectory,
      ".context-overflow",
      "copilot-sdk"
    );
    mkdirSync(baseDirectory, { recursive: true });
    this.#client = new this.#sdk.CopilotClient({
      mode: "empty",
      workingDirectory: normalizedWorkingDirectory,
      baseDirectory,
      useLoggedInUser: true
    });
    await this.#client.start();
    this.#clientWorkingDirectory = normalizedWorkingDirectory;
    return this.#client;
  }

  async listModels(
    workingDirectory = process.cwd()
  ): Promise<Result<readonly ModelCatalogEntry[]>> {
    try {
      const client = await this.#ensureClient(workingDirectory);
      const models = await client.listModels();
      return success(models.map(normalizeModel));
    } catch (error) {
      return failure("IO_ERROR", "Unable to load Copilot model catalog", {
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async send(
    input: ApprovedAgentSendRequest
  ): Promise<Result<AgentSendReceipt>> {
    const request = snapshotRequest(input);
    const { approved } = request;
    if (
      request.runId !== approved.subject.runId ||
      request.readScope.runId !== request.runId
    ) {
      return failure("INTEGRITY_ERROR", "Run-scoped approval mismatch");
    }
    const approval = validateApproval({
      subject: approved.subject,
      approval: approved.approval,
      payload: approved.bytes
    });
    if (!approval.ok) return approval;
    if (approved.subject.evidenceDecision !== "ready") {
      return failure(
        "INVALID_ARGUMENT",
        "Gather More Evidence must complete before external send"
      );
    }
    if (
      approved.subject.reviewProducerRegistry.digest !==
        canonicalJsonDigest(
          approved.subject.reviewProducerRegistry.producers
        ) ||
      approved.subject.reviewProducerRegistry.producers.some(
        (producer) => !builtinRuntime.resolveProducer(producer)
      )
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Approval review runtime is stale or unavailable"
      );
    }
    const scopeDigest = agentReadScopeDigest(request.readScope);
    if (
      !scopeDigest.ok ||
      scopeDigest.value !== approved.subject.readScopeDigest
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Run-scoped reads do not match the approved review subject"
      );
    }
    if (this.#authority === undefined) {
      return failure(
        "INTEGRITY_ERROR",
        "Committed run scope authority is required for external send"
      );
    }
    const authoritativeScope = this.#authority.validate(
      request.runId,
      request.readScope
    );
    if (!authoritativeScope.ok) return authoritativeScope;
    if (!approved.subject.target.permissions.network) {
      return failure(
        "INVALID_ARGUMENT",
        "External Copilot send requires explicit network permission"
      );
    }
    if (
      approved.subject.target.modelId === undefined ||
      approved.subject.target.modelId.length === 0
    ) {
      return failure(
        "INVALID_ARGUMENT",
        "Copilot approval must bind an explicit model"
      );
    }
    const security = validateExternalSendAuthorization({
      payload: approved.bytes,
      assessment: request.security.assessment,
      authorization: request.security.authorization,
      assessedSource: request.security.assessedSource,
      ...(request.security.redactedView === undefined
        ? {}
        : { redactedView: request.security.redactedView }),
      ...(request.security.redactionHmacKey === undefined
        ? {}
        : { redactionHmacKey: request.security.redactionHmacKey })
    });
    if (!security.ok) return security;
    if (approved.subject.target.adapterId !== this.metadata.producerId) {
      return failure("INVALID_ARGUMENT", "Approval targets another adapter", {
        target: approved.subject.target.adapterId
      });
    }
    if (request.timeoutMs <= 0) {
      return failure("INVALID_ARGUMENT", "Timeout must be positive");
    }
    const prompt = approved.bytes.toString("utf8");
    if (!Buffer.from(prompt, "utf8").equals(approved.bytes)) {
      return failure(
        "INVALID_UTF8",
        "Approved application payload is not exact UTF-8"
      );
    }

    try {
      const client = await this.#ensureClient(
        approved.subject.target.workingDirectory
      );
      const sdk = this.#sdk as SdkModuleLike;
      const events: AgentEventRecord[] = [];
      const tools = scopedToolsForPermissions(
        sdk,
        request.readScope,
        approved.subject.target.permissions
      );
      const toolNames = [
        ...(approved.subject.target.permissions.evidenceRead
          ? ["evidence_read"]
          : []),
        ...(approved.subject.target.permissions.sourceRead
          ? ["source_read"]
          : [])
      ];
      const bindingDigest = canonicalJsonDigest({
        runId: request.runId,
        modelId: approved.subject.target.modelId ?? null,
        workingDirectory: approved.subject.target.workingDirectory,
        permissions: approved.subject.target.permissions,
        readScopeDigest: scopeDigest.value
      });
      const baseConfig = {
        clientName: "context-overflow",
        workingDirectory: approved.subject.target.workingDirectory,
        systemMessage: {
          mode: "append",
          content:
            "Use only the approved application payload and run-scoped evidence_read/source_read tools."
        },
        tools,
        availableTools: toolNames,
        onEvent: (event: SdkEvent) => events.push(eventRecord(event)),
        onPermissionRequest: permissionHandler(
          approved.subject.target.permissions
        )
      };
      const targetSessionId = approved.subject.target.sessionId;
      const cached =
        targetSessionId === undefined
          ? undefined
          : this.#sessions.get(targetSessionId);
      if (
        cached !== undefined &&
        (cached.runId !== request.runId ||
          cached.workingDirectory !==
            approved.subject.target.workingDirectory ||
          cached.modelId !== approved.subject.target.modelId)
      ) {
        return failure(
          "INTEGRITY_ERROR",
          "Approved session belongs to a different run, model, or directory"
        );
      }
      if (
        targetSessionId !== undefined &&
        cached === undefined
      ) {
        return failure(
          "INVALID_ARGUMENT",
          "Resuming an uncached session cannot verify its approved model; create a new session"
        );
      }
      let session = cached?.session;
      if (cached !== undefined && cached.bindingDigest !== bindingDigest) {
        await cached.session.disconnect();
        session = await client.resumeSession(targetSessionId as string, baseConfig);
        this.#sessions.set(targetSessionId as string, {
          session,
          bindingDigest,
          runId: request.runId,
          modelId: cached.modelId,
          workingDirectory: approved.subject.target.workingDirectory
        });
      } else if (session === undefined) {
        session =
          targetSessionId === undefined
            ? await client.createSession({
                ...baseConfig,
                model: approved.subject.target.modelId
              })
            : await client.resumeSession(targetSessionId, baseConfig);
        this.#sessions.set(session.sessionId, {
          session,
          bindingDigest,
          runId: request.runId,
          modelId: approved.subject.target.modelId,
          workingDirectory: approved.subject.target.workingDirectory
        });
      }
      let timedOut = false;
      let aborted = false;
      let timer: NodeJS.Timeout | undefined;
      const unsubscribe = session.on((event) =>
        events.push(eventRecord(event))
      );
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error("CTXO_COPILOT_TIMEOUT"));
          }, request.timeoutMs);
        });
        const response = await Promise.race([
          session.sendAndWait({ prompt }, request.timeoutMs + 5_000),
          timeout
        ]);
        const responseText = assistantText(response);
        return success({
          runId: request.runId,
          sessionId: session.sessionId,
          ...(approved.subject.target.modelId === undefined
            ? {}
            : { modelId: approved.subject.target.modelId }),
          applicationPayloadSha256: sha256Base64Url(approved.bytes),
          permissions: approved.subject.target.permissions,
          events,
          ...(responseText === undefined ? {} : { responseText }),
          timedOut,
          aborted,
          producer: this.metadata
        });
      } catch (error) {
        if (timedOut) {
          await session.abort();
          aborted = true;
          return failure("IO_ERROR", "Copilot request timed out and was aborted", {
            sessionId: session.sessionId,
            timedOut,
            aborted
          });
        }
        return failure("IO_ERROR", "Copilot request failed", {
          sessionId: session.sessionId,
          cause: error instanceof Error ? error.message : String(error)
        });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        unsubscribe();
      }
    } catch (error) {
      return failure("IO_ERROR", "Unable to initialize Copilot SDK adapter", {
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async close(): Promise<Result<void>> {
    try {
      for (const cached of this.#sessions.values()) {
        await cached.session.disconnect();
      }
      this.#sessions.clear();
      if (this.#client !== undefined) {
        const errors = await this.#client.stop();
        if (errors.length > 0) {
          return failure("IO_ERROR", "Copilot SDK cleanup reported errors", {
            errors: errors.map((error) => error.message)
          });
        }
      }
      this.#client = undefined;
      this.#clientWorkingDirectory = undefined;
      this.#sdk = undefined;
      return success(undefined);
    } catch (error) {
      return failure("IO_ERROR", "Copilot SDK cleanup failed", {
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

export const optionalCopilotSdkAdapter = new OptionalCopilotSdkAdapter();
