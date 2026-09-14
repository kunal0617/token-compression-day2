import type {
  IsolatedHelperTransport
} from "../contracts/helper.js";
import type { ProducerMetadata } from "../contracts/providers.js";
import { canonicalJsonDigest } from "../core/canonical.js";

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
  start(): Promise<void>;
  createSession(config: Readonly<Record<string, unknown>>): Promise<HostedHelperSession>;
  stop(): Promise<Error[]>;
}

export type HostedHelperClientFactory = () => Promise<HostedHelperClient>;

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

  async complete(prompt: string, timeoutMs: number): Promise<string> {
    const client = await this.#factory();
    await client.start();
    const session = await client.createSession({
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
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    try {
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
      if (timedOut) await session.abort();
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await session.disconnect();
      await client.stop();
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
  readonly #model: string;
  readonly #fetch: typeof fetch;

  constructor(input: {
    readonly endpoint: string;
    readonly model: string;
    readonly fetchImpl?: typeof fetch;
  }) {
    this.#endpoint = new URL(input.endpoint);
    if (
      !["localhost", "127.0.0.1", "::1"].includes(this.#endpoint.hostname)
    ) {
      throw new TypeError("Local helper endpoint must resolve to loopback");
    }
    this.#model = input.model;
    this.#fetch = input.fetchImpl ?? fetch;
  }

  async complete(prompt: string, timeoutMs: number): Promise<string> {
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
        signal: controller.signal
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

