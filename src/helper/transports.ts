import type {
  IsolatedHelperTransport
} from "../contracts/helper.js";
import type { ProducerMetadata } from "../contracts/providers.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import {
  validateExternalSendAuthorization
} from "../security/security.js";
import { lookup } from "node:dns/promises";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

function isLoopbackAddress(address: string): boolean {
  return (
    address === "::1" ||
    address.startsWith("127.") ||
    address.toLowerCase().startsWith("::ffff:127.")
  );
}

function metadata(
  producerId: string,
  version: string,
  contract: unknown
): ProducerMetadata {
  return {
    producerId,
    kind: "helper-model",
    version,
    digest: canonicalJsonDigest({ producerId, version, contract })
  };
}

export interface HostedHelperSession {
  sendAndWait(
    options: { prompt: string },
    timeout?: number
  ): Promise<{ data?: { content?: string } } | undefined>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface HostedHelperClient {
  readonly configurationDigest: string;
  start(): Promise<void>;
  createSession(config: Readonly<Record<string, unknown>>): Promise<HostedHelperSession>;
  stop(): Promise<Error[]>;
}

export interface HostedHelperClientConfiguration {
  readonly mode: "empty";
  readonly workingDirectory: string;
  readonly baseDirectory: string;
  readonly useLoggedInUser: true;
}

export type HostedHelperClientFactory = (
  configuration: HostedHelperClientConfiguration
) => Promise<HostedHelperClient>;

export class HostedCopilotHelperTransport implements IsolatedHelperTransport {
  readonly metadata = metadata(
    "optional.helper.hosted-copilot-empty",
    "1.0.0",
    ["empty-mode", "new-session", "no-tools", "no-files", "abort-on-timeout"]
  );
  readonly #factory: HostedHelperClientFactory;

  constructor(factory: HostedHelperClientFactory) {
    this.#factory = factory;
  }

  async complete(
    prompt: string,
    timeoutMs: number,
    security?: Parameters<IsolatedHelperTransport["complete"]>[2]
  ): Promise<string> {
    if (security?.networkApproved !== true) {
      throw new Error("Hosted helper network approval is required");
    }
    const authorized = validateExternalSendAuthorization({
      payload: Buffer.from(prompt, "utf8"),
      assessment: security.assessment,
      authorization: security.authorization,
      assessedSource: security.assessedSource
    });
    if (!authorized.ok) throw new Error(authorized.error.message);
    const baseDirectory = resolve(
      ".context-overflow",
      "helper",
      randomUUID()
    );
    mkdirSync(baseDirectory, { recursive: true });
    const configuration: HostedHelperClientConfiguration = {
      mode: "empty",
      workingDirectory: baseDirectory,
      baseDirectory,
      useLoggedInUser: true
    };
    const configurationDigest = canonicalJsonDigest(configuration);
    let client: HostedHelperClient | undefined;
    let session: HostedHelperSession | undefined;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
      client = await this.#factory(configuration);
      if (client.configurationDigest !== configurationDigest) {
        throw new Error(
          "Hosted helper client did not attest the required empty-mode configuration"
        );
      }
      await client.start();
      session = await client.createSession({
        clientName: "context-overflow-helper",
        availableTools: [],
        tools: [],
        includedBuiltinSkills: [],
        installedPlugins: [],
        systemMessage: {
          mode: "append",
          content:
            "Return only the requested JSON evidence-gap suggestions. Do not use tools or files."
        }
      });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("helper timeout"));
        }, timeoutMs);
      });
      const response = await Promise.race([
        session.sendAndWait({ prompt }, timeoutMs + 5_000),
        timeout
      ]);
      return response?.data?.content ?? "";
    } catch (error) {
      if (timedOut && session !== undefined) await session.abort();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (session !== undefined) await session.disconnect();
      if (client !== undefined) await client.stop();
      rmSync(baseDirectory, { recursive: true, force: true });
    }
  }
}

export class LocalOpenAiCompatibleHelperTransport
  implements IsolatedHelperTransport
{
  readonly metadata = metadata(
    "optional.helper.local-openai-compatible",
    "1.0.0",
    ["localhost-only", "chat-completions", "no-tools", "timeout"]
  );
  readonly #endpoint: URL;
  readonly #hostname: string;
  readonly #model: string;
  readonly #fetch: typeof fetch;

  constructor(input: {
    readonly endpoint: string;
    readonly model: string;
    readonly fetchImpl?: typeof fetch;
  }) {
    this.#endpoint = new URL(input.endpoint);
    this.#hostname = this.#endpoint.hostname.replace(/^\[|\]$/g, "");
    if (
      !["http:", "https:"].includes(this.#endpoint.protocol) ||
      this.#endpoint.username.length > 0 ||
      this.#endpoint.password.length > 0 ||
      !["localhost", "127.0.0.1", "::1"].includes(this.#hostname)
    ) {
      throw new TypeError("Local helper endpoint must resolve to loopback");
    }
    this.#model = input.model;
    this.#fetch = input.fetchImpl ?? fetch;
  }

  async complete(prompt: string, timeoutMs: number): Promise<string> {
    const addresses = await lookup(this.#hostname, { all: true });
    if (
      addresses.length === 0 ||
      addresses.some((entry) => !isLoopbackAddress(entry.address))
    ) {
      throw new Error("Local helper hostname did not resolve to loopback");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.#model,
          messages: [{ role: "user", content: prompt }],
          tools: [],
          stream: false
        }),
        signal: controller.signal,
        redirect: "error"
      });
      if (!response.ok) {
        throw new Error(`Local helper HTTP ${response.status}`);
      }
      const body = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return body.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }
  }
}
