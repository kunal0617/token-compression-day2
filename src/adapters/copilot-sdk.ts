import { z } from "zod";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type {
  AgentEventRecord,
  AgentReadScope,
  AgentSendReceipt,
  ApprovedAgentSendRequest,
  ModelCatalogEntry
} from "../contracts/agent.js";
import type { ProducerMetadata } from "../contracts/providers.js";
import { validateApproval } from "../approval/review.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import { sha256Base64Url } from "../core/hash.js";
import { failure, success, type Result } from "../core/result.js";

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

function permissionHandler(
  permissions: ApprovedAgentSendRequest["approved"]["subject"]["target"]["permissions"]
) {
  return (request: { readonly kind?: string }) => {
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

function scopedTools(sdk: SdkModuleLike, scope: AgentReadScope): unknown[] {
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
  return [
    sdk.defineTool("evidence_read", {
      description: "Read one approved evidence occurrence from this run",
      parameters: evidenceSchema,
      skipPermission: true,
      handler: (args) => {
        if (args.runId !== scope.runId) {
          throw new Error("Cross-run evidence read rejected");
        }
        const evidence = scope.evidence.find(
          (item) => item.span.evidenceId === args.evidenceId
        );
        if (evidence === undefined) {
          throw new Error("Unapproved evidence occurrence");
        }
        return {
          evidenceId: evidence.span.evidenceId,
          artifactId: evidence.span.artifactId,
          startByte: evidence.span.startByte,
          endByte: evidence.span.endByte,
          sha256: evidence.span.sha256,
          text: evidence.bytes.toString("utf8")
        };
      }
    }),
    sdk.defineTool("source_read", {
      description: "Read an approved exact source range from this run",
      parameters: sourceSchema,
      skipPermission: true,
      handler: (args) => {
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
        return {
          sourceId: source.sourceId,
          startByte: args.startByte,
          endByte: args.endByte,
          text: source.bytes
            .subarray(relativeStart, relativeEnd)
            .toString("utf8")
        };
      }
    })
  ];
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
  #client: SdkClientLike | undefined;
  #sdk: SdkModuleLike | undefined;
  readonly #sessions = new Map<string, SdkSessionLike>();

  constructor(loader: CopilotSdkLoader = defaultLoader) {
    this.#loader = loader;
  }

  async #ensureClient(workingDirectory: string): Promise<SdkClientLike> {
    if (this.#client !== undefined) return this.#client;
    this.#sdk = await this.#loader();
    const baseDirectory = resolve(
      workingDirectory,
      ".context-overflow",
      "copilot-sdk"
    );
    mkdirSync(baseDirectory, { recursive: true });
    this.#client = new this.#sdk.CopilotClient({
      mode: "empty",
      workingDirectory,
      baseDirectory,
      useLoggedInUser: true
    });
    await this.#client.start();
    return this.#client;
  }

  async listModels(
    workingDirectory = process.cwd()
  ): Promise<Result<readonly ModelCatalogEntry[]>> {
    try {
      const client = await this.#ensureClient(workingDirectory);
      const models = await client.listModels();
      return success(
        models.map((model) => ({
          id: model.id,
          name: model.name,
          capabilities: model.capabilities ?? {}
        }))
      );
    } catch (error) {
      return failure("IO_ERROR", "Unable to load Copilot model catalog", {
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async send(
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
      const tools = scopedTools(sdk, request.readScope);
      const config = {
        clientName: "context-overflow",
        model: approved.subject.target.modelId,
        workingDirectory: approved.subject.target.workingDirectory,
        systemMessage: {
          mode: "append",
          content:
            "Use only the approved application payload and run-scoped evidence_read/source_read tools."
        },
        tools,
        availableTools: ["evidence_read", "source_read"],
        onPermissionRequest: permissionHandler(
          approved.subject.target.permissions
        )
      };
      let session =
        request.resumeSessionId === undefined
          ? undefined
          : this.#sessions.get(request.resumeSessionId);
      if (session === undefined) {
        session =
          request.resumeSessionId === undefined
            ? await client.createSession(config)
            : await client.resumeSession(request.resumeSessionId, config);
        this.#sessions.set(session.sessionId, session);
      }
      const events: AgentEventRecord[] = [];
      const unsubscribe = session.on((event) => events.push(eventRecord(event)));
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
      for (const session of this.#sessions.values()) {
        await session.disconnect();
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
