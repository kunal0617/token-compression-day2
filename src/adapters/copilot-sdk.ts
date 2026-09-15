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
  forceStop(): Promise<void>;
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
      approval: structuredClone(input.approved.approval),
      evidenceFacts: structuredClone(input.approved.evidenceFacts),
      authorityToken: input.approved.authorityToken
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

function providerUsage(events: readonly SdkEvent[]) {
  const usage = events.flatMap((event) => {
    if (
      event.type !== "assistant.usage" ||
      event.data === null ||
      typeof event.data !== "object"
    ) {
      return [];
    }
    const data = event.data as Readonly<Record<string, unknown>>;
    const inputTokens = data.inputTokens;
    const outputTokens = data.outputTokens;
    const model = data.model;
    return typeof inputTokens === "number" &&
      Number.isFinite(inputTokens) &&
      inputTokens >= 0 &&
      typeof outputTokens === "number" &&
      Number.isFinite(outputTokens) &&
      outputTokens >= 0 &&
      typeof model === "string"
      ? [{ inputTokens, outputTokens, model }]
      : [];
  });
  return usage.length === 0
    ? undefined
    : {
        inputTokens: usage.reduce(
          (total, item) => total + item.inputTokens,
          0
        ),
        outputTokens: usage.reduce(
          (total, item) => total + item.outputTokens,
          0
        ),
        modelIds: [...new Set(usage.map((item) => item.model))].sort(
          (left, right) =>
            Buffer.compare(
              Buffer.from(left, "utf8"),
              Buffer.from(right, "utf8")
            )
        )
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

async function boundedCleanup(
  operation: Promise<unknown>,
  timeoutMs = 5_000
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation.then(() => true, () => false),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class OptionalCopilotSdkAdapter {
  readonly metadata = metadata();
  readonly #loader: CopilotSdkLoader;
  readonly #authority: AgentRunScopeAuthority | undefined;
  readonly #catalogTimeoutMs: number;
  readonly #cleanupTimeoutMs: number;
  readonly #onTimeout:
    | ((details: {
        readonly runId: string;
        readonly sessionId: string;
      }) => Promise<void> | void)
    | undefined;
  #client: SdkClientLike | undefined;
  #clientWorkingDirectory: string | undefined;
  #forceClosePromise: Promise<Result<void>> | undefined;
  #operationTail: Promise<void> = Promise.resolve();
  #sdk: SdkModuleLike | undefined;
  readonly #sessions = new Map<
    string,
    {
      readonly session: SdkSessionLike;
      readonly bindingDigest: string;
      readonly runId: string;
      readonly modelId: string;
      readonly workingDirectory: string;
      readonly eventSink: {
        current: ((event: SdkEvent) => void) | undefined;
      };
    }
  >();

  constructor(
    loader: CopilotSdkLoader = defaultLoader,
    authority?: AgentRunScopeAuthority,
    options: {
      readonly catalogTimeoutMs?: number;
      readonly cleanupTimeoutMs?: number;
      readonly onTimeout?: (details: {
        readonly runId: string;
        readonly sessionId: string;
      }) => Promise<void> | void;
    } = {}
  ) {
    this.#loader = loader;
    this.#authority = authority;
    this.#catalogTimeoutMs =
      options.catalogTimeoutMs ?? 30_000;
    this.#cleanupTimeoutMs =
      options.cleanupTimeoutMs ?? 5_000;
    this.#onTimeout = options.onTimeout;
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#operationTail;
    let release = (): void => undefined;
    this.#operationTail = new Promise<void>((resolveOperation) => {
      release = resolveOperation;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
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
    return this.#exclusive(async () => {
      try {
        const client = await this.#ensureClient(workingDirectory);
        let timer: NodeJS.Timeout | undefined;
        const result = await Promise.race([
          client.listModels().then(
            (models) => ({ kind: "completed" as const, models }),
            (error: unknown) => ({ kind: "failed" as const, error })
          ),
          new Promise<{ readonly kind: "timed-out" }>(
            (resolveTimeout) => {
              timer = setTimeout(
                () => resolveTimeout({ kind: "timed-out" }),
                this.#catalogTimeoutMs
              );
            }
          )
        ]).finally(() => {
          if (timer !== undefined) clearTimeout(timer);
        });
        if (result.kind === "timed-out") {
          const forced = await this.forceClose();
          return failure(
            "IO_ERROR",
            "Copilot model catalog request timed out",
            {
              reason: "catalog-timeout",
              cleanupConfirmed: forced.ok
            }
          );
        }
        if (result.kind === "failed") {
          throw result.error;
        }
        const models = result.models;
        return success(models.map(normalizeModel));
      } catch (error) {
        return failure("IO_ERROR", "Unable to load Copilot model catalog", {
          cause: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }

  async forceClose(): Promise<Result<void>> {
    if (this.#forceClosePromise !== undefined) {
      return this.#forceClosePromise;
    }
    const client = this.#client;
    this.#client = undefined;
    this.#clientWorkingDirectory = undefined;
    this.#sdk = undefined;
    this.#sessions.clear();
    if (client === undefined) return success(undefined);
    const operation = (async (): Promise<Result<void>> => {
      try {
        const stopped = await boundedCleanup(
          Promise.resolve().then(() => client.forceStop()),
          this.#cleanupTimeoutMs
        );
        return stopped
          ? success(undefined)
          : failure(
              "IO_ERROR",
              "Copilot SDK forced cleanup timed out",
              {
                reason: "forced-cleanup-timeout",
                cleanupConfirmed: false
              }
            );
      } catch (error) {
        return failure("IO_ERROR", "Copilot SDK forced cleanup failed", {
          reason: "forced-cleanup-failed",
          cleanupConfirmed: false,
          cause: error instanceof Error ? error.message : String(error)
        });
      }
    })();
    this.#forceClosePromise = operation;
    try {
      return await operation;
    } finally {
      if (this.#forceClosePromise === operation) {
        this.#forceClosePromise = undefined;
      }
    }
  }

  async send(
    input: ApprovedAgentSendRequest
  ): Promise<Result<AgentSendReceipt>> {
    const request = snapshotRequest(input);
    return this.#exclusive(() => this.#sendSnapshot(request));
  }

  async #sendSnapshot(
    request: ApprovedAgentSendRequest
  ): Promise<Result<AgentSendReceipt>> {
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
    const authoritativeRequest = this.#authority.validate(request);
    if (!authoritativeRequest.ok) return authoritativeRequest;
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
    if (
      request.security.assessedSource.trustClass !==
        "external-untrusted" ||
      !request.security.assessedSource.bytes.equals(approved.bytes)
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Copilot outbound security must conservatively assess the exact approved payload"
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
      const rawEvents: SdkEvent[] = [];
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
        readScopeDigest: scopeDigest.value,
        contextTier:
          approved.subject.target.contextTier ?? null,
        reasoningEffort:
          approved.subject.target.reasoningEffort ?? null
      });
      const applicationSettingsDigest = canonicalJsonDigest({
        modelId: approved.subject.target.modelId,
        contextTier:
          approved.subject.target.contextTier ?? null,
        reasoningEffort:
          approved.subject.target.reasoningEffort ?? null,
        permissions: approved.subject.target.permissions,
        availableTools: toolNames
      });
      const collectEvent = (event: SdkEvent): void => {
        rawEvents.push(event);
        events.push(eventRecord(event));
      };
      const eventSink: {
        current: ((event: SdkEvent) => void) | undefined;
      } = { current: collectEvent };
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
        onEvent: (event: SdkEvent) =>
          eventSink.current?.(event),
        onPermissionRequest: permissionHandler(
          approved.subject.target.permissions
        ),
        ...(approved.subject.target.contextTier === undefined
          ? {}
          : {
              contextTier:
                approved.subject.target.contextTier
            }),
        ...(approved.subject.target.reasoningEffort === undefined
          ? {}
          : {
              reasoningEffort:
                approved.subject.target.reasoningEffort
            })
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
      let activeEventSink = eventSink;
      if (cached !== undefined && cached.bindingDigest !== bindingDigest) {
        await cached.session.disconnect();
        session = await client.resumeSession(targetSessionId as string, baseConfig);
        this.#sessions.set(targetSessionId as string, {
          session,
          bindingDigest,
          runId: request.runId,
          modelId: cached.modelId,
          workingDirectory: approved.subject.target.workingDirectory,
          eventSink
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
          workingDirectory: approved.subject.target.workingDirectory,
          eventSink
        });
      } else if (cached !== undefined) {
        activeEventSink = cached.eventSink;
        activeEventSink.current = collectEvent;
      }
      let timedOut = false;
      let aborted = false;
      let timer: NodeJS.Timeout | undefined;
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
        const usage = providerUsage(rawEvents);
        return success({
          runId: request.runId,
          sessionId: session.sessionId,
          ...(approved.subject.target.modelId === undefined
            ? {}
            : { modelId: approved.subject.target.modelId }),
          applicationPayloadSha256: sha256Base64Url(approved.bytes),
          applicationSettingsDigest,
          permissions: approved.subject.target.permissions,
          events,
          ...(usage === undefined
            ? {}
            : { providerUsage: usage }),
          ...(responseText === undefined ? {} : { responseText }),
          timedOut,
          aborted,
          producer: this.metadata
        });
      } catch (error) {
        if (timedOut) {
          await this.#onTimeout?.({
            runId: request.runId,
            sessionId: session.sessionId
          });
          const abortCompleted = await boundedCleanup(
            session.abort(),
            this.#cleanupTimeoutMs
          );
          aborted = abortCompleted;
          return failure("IO_ERROR", "Copilot request timed out; abort was attempted", {
            sessionId: session.sessionId,
            reason: "timeout",
            timedOut,
            aborted,
            abortCompleted
          });
        }
        return failure("IO_ERROR", "Copilot request failed", {
          sessionId: session.sessionId,
          cause: error instanceof Error ? error.message : String(error)
        });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        activeEventSink.current = undefined;
      }
    } catch (error) {
      return failure("IO_ERROR", "Unable to initialize Copilot SDK adapter", {
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async close(): Promise<Result<void>> {
    return this.#exclusive(async () => {
      try {
        for (const cached of this.#sessions.values()) {
          const disconnected = await boundedCleanup(
            cached.session.disconnect(),
            this.#cleanupTimeoutMs
          );
          if (!disconnected) {
            const forced = await this.forceClose();
            return failure(
              "IO_ERROR",
              "Copilot SDK session cleanup timed out",
              {
                reason: "cleanup-timeout",
                cleanupConfirmed: forced.ok
              }
            );
          }
        }
        this.#sessions.clear();
        if (this.#client !== undefined) {
          let errors: Error[] | undefined;
          let timer: NodeJS.Timeout | undefined;
          try {
            errors = await Promise.race([
              this.#client.stop(),
              new Promise<undefined>((resolveTimeout) => {
                timer = setTimeout(
                  () => resolveTimeout(undefined),
                  this.#cleanupTimeoutMs
                );
              })
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
          if (errors === undefined) {
            const forced = await this.forceClose();
            return failure(
              "IO_ERROR",
              "Copilot SDK client cleanup timed out",
              {
                reason: "cleanup-timeout",
                cleanupConfirmed: forced.ok
              }
            );
          }
          if (errors.length > 0) {
            const forced = await this.forceClose();
            return failure("IO_ERROR", "Copilot SDK cleanup reported errors", {
              reason: "cleanup-errors",
              cleanupConfirmed: forced.ok,
              errorDigests: errors.map((error) =>
                canonicalJsonDigest(error.message)
              )
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
    });
  }
}

export const optionalCopilotSdkAdapter = new OptionalCopilotSdkAdapter();
