import { describe, expect, it } from "vitest";

import type {
  SdkClientLike,
  SdkEvent,
  SdkModuleLike,
  SdkSessionLike
} from "../../src/adapters/copilot-sdk.js";
import { OptionalCopilotSdkAdapter } from "../../src/adapters/copilot-sdk.js";
import type { ApprovedAgentSendRequest } from "../../src/contracts/agent.js";
import {
  approveReviewSubject,
  reviewSubjectProvider
} from "../../src/approval/review.js";
import { canonicalJsonDigest } from "../../src/core/canonical.js";
import { sha256Base64Url } from "../../src/core/hash.js";
import {
  assessSecurity,
  authorizeExternalSend
} from "../../src/security/security.js";

interface DefinedTool {
  readonly name: string;
  readonly config: {
    readonly handler: (args: unknown) => unknown;
  };
}

class FakeSession implements SdkSessionLike {
  readonly sessionId: string;
  readonly prompts: string[] = [];
  readonly handlers: ((event: SdkEvent) => void)[] = [];
  aborted = false;
  disconnected = false;
  pending = false;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  on(handler: (event: SdkEvent) => void): () => void {
    this.handlers.push(handler);
    return () => undefined;
  }

  async sendAndWait(options: { prompt: string }): Promise<SdkEvent | undefined> {
    this.prompts.push(options.prompt);
    this.handlers.forEach((handler) =>
      handler({
        type: "assistant.message",
        timestamp: "2030-01-01T00:00:00.000Z",
        data: { content: "OK" }
      })
    );
    if (this.pending) return new Promise(() => undefined);
    return {
      type: "assistant.message",
      data: { content: "OK" }
    };
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

class FakeClient implements SdkClientLike {
  readonly created: Readonly<Record<string, unknown>>[] = [];
  readonly resumed: string[] = [];
  readonly session = new FakeSession("session-1");
  started = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<Error[]> {
    return [];
  }

  async createSession(
    config: Readonly<Record<string, unknown>>
  ): Promise<SdkSessionLike> {
    this.created.push(config);
    return this.session;
  }

  async resumeSession(
    sessionId: string,
    config: Readonly<Record<string, unknown>>
  ): Promise<SdkSessionLike> {
    this.resumed.push(sessionId);
    this.created.push(config);
    return this.session;
  }

  async listModels() {
    return [
      {
        id: "model-1",
        name: "Model One",
        capabilities: { supportsReasoning: true }
      }
    ];
  }
}

function fakeSdk(client: FakeClient, tools: DefinedTool[]): SdkModuleLike {
  return {
    CopilotClient: class {
      constructor() {
        return client;
      }
    } as unknown as SdkModuleLike["CopilotClient"],
    defineTool: (name, config) => {
      const tool = {
        name,
        config: {
          handler: config.handler as (args: unknown) => unknown
        }
      };
      tools.push(tool);
      return tool;
    }
  };
}

function request(
  adapter: OptionalCopilotSdkAdapter,
  options: { timeoutMs?: number; resumeSessionId?: string } = {}
): ApprovedAgentSendRequest {
  const bytes = Buffer.from("Approved payload", "utf8");
  const subject = reviewSubjectProvider.provide({
    runId: "run-1",
    payload: bytes,
    sourceIdentities: [],
    policyDigest: canonicalJsonDigest("policy"),
    detectorRegistryDigest: canonicalJsonDigest("registry"),
    tokenizer: "o200k_base",
    target: {
      adapterId: adapter.metadata.producerId,
      modelId: "model-1",
      workingDirectory: process.cwd(),
      permissions: {
        sourceRead: true,
        evidenceRead: true,
        fileWrite: false,
        shell: false,
        network: true
      }
    },
    snapshotChoice: "captured"
  });
  if (!subject.ok) throw new Error(subject.error.message);
  const approval = approveReviewSubject({
    subject: subject.value,
    payload: bytes,
    decision: "approve-prepared"
  });
  if (!approval.ok) throw new Error(approval.error.message);
  const assessment = assessSecurity([
    { sourceId: "payload", bytes, trustClass: "user-instruction" }
  ]);
  const authorization = authorizeExternalSend({
    payload: bytes,
    assessment,
    explicitApproval: true
  });
  if (!authorization.ok) throw new Error(authorization.error.message);
  return {
    runId: "run-1",
    approved: {
      bytes,
      subject: subject.value,
      approval: approval.value
    },
    readScope: {
      runId: "run-1",
      evidence: [
        {
          span: {
            evidenceId: "evidence-1",
            occurrenceId: "occurrence-1",
            artifactId: "artifact-1",
            kind: "final-summary",
            startByte: 0,
            endByte: 7,
            sha256: sha256Base64Url(Buffer.from("summary", "utf8")),
            textPreview: "summary",
            reasons: ["test"],
            mandatoryInline: true,
            protectionReasons: ["test"]
          },
          bytes: Buffer.from("summary", "utf8")
        }
      ],
      sources: [
        {
          sourceId: "source-1",
          path: "source.ts",
          startByte: 10,
          endByte: 16,
          bytes: Buffer.from("source", "utf8"),
          sha256: sha256Base64Url(Buffer.from("source", "utf8")),
          unitIds: ["unit-1"]
        }
      ]
    },
    security: {
      assessment,
      authorization: authorization.value
    },
    timeoutMs: options.timeoutMs ?? 100,
    ...(options.resumeSessionId === undefined
      ? {}
      : { resumeSessionId: options.resumeSessionId })
  };
}

describe("optional GitHub Copilot SDK adapter", () => {
  it("sends only a valid approved payload and exposes scoped read tools", async () => {
    const client = new FakeClient();
    const tools: DefinedTool[] = [];
    const adapter = new OptionalCopilotSdkAdapter(async () =>
      fakeSdk(client, tools)
    );
    const sent = await adapter.send(request(adapter));

    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(client.session.prompts).toEqual(["Approved payload"]);
    expect(sent.value.applicationPayloadSha256).toBe(
      sha256Base64Url(Buffer.from("Approved payload", "utf8"))
    );
    expect(sent.value.responseText).toBe("OK");
    const evidenceTool = tools.find((tool) => tool.name === "evidence_read");
    const sourceTool = tools.find((tool) => tool.name === "source_read");
    expect(
      evidenceTool?.config.handler({
        runId: "run-1",
        evidenceId: "evidence-1"
      })
    ).toMatchObject({ text: "summary" });
    expect(() =>
      evidenceTool?.config.handler({
        runId: "other",
        evidenceId: "evidence-1"
      })
    ).toThrow();
    expect(
      sourceTool?.config.handler({
        runId: "run-1",
        sourceId: "source-1",
        startByte: 10,
        endByte: 16
      })
    ).toMatchObject({ text: "source" });

    const config = client.created[0] as {
      onPermissionRequest: (request: { kind: string }) => unknown;
    };
    expect(config.onPermissionRequest({ kind: "shell" })).toMatchObject({
      kind: "reject"
    });
    expect(config.onPermissionRequest({ kind: "write" })).toMatchObject({
      kind: "reject"
    });
    expect((await adapter.listModels()).ok).toBe(true);
    expect((await adapter.close()).ok).toBe(true);
  });

  it("resumes a stable requested session", async () => {
    const client = new FakeClient();
    const adapter = new OptionalCopilotSdkAdapter(async () =>
      fakeSdk(client, [])
    );
    const sent = await adapter.send(
      request(adapter, { resumeSessionId: "existing-session" })
    );
    expect(sent.ok).toBe(true);
    expect(client.resumed).toEqual(["existing-session"]);
    await adapter.close();
  });

  it("calls session.abort when application timeout wins", async () => {
    const client = new FakeClient();
    client.session.pending = true;
    const adapter = new OptionalCopilotSdkAdapter(async () =>
      fakeSdk(client, [])
    );
    const sent = await adapter.send(request(adapter, { timeoutMs: 5 }));
    expect(sent.ok).toBe(false);
    expect(client.session.aborted).toBe(true);
    await adapter.close();
  });

  it("rejects changed payloads and cross-run scopes before SDK use", async () => {
    const client = new FakeClient();
    const adapter = new OptionalCopilotSdkAdapter(async () =>
      fakeSdk(client, [])
    );
    const changed = request(adapter);
    const invalid = {
      ...changed,
      approved: {
        ...changed.approved,
        bytes: Buffer.from("changed", "utf8")
      }
    };
    expect((await adapter.send(invalid)).ok).toBe(false);
    expect(
      (
        await adapter.send({
          ...changed,
          readScope: { ...changed.readScope, runId: "other" }
        })
      ).ok
    ).toBe(false);
    expect(client.started).toBe(false);
  });
});
