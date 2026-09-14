import { describe, expect, it } from "vitest";

import type {
  IsolatedHelperTransport
} from "../../src/contracts/helper.js";
import type { ProducerMetadata } from "../../src/contracts/providers.js";
import { canonicalJsonDigest } from "../../src/core/canonical.js";
import { IsolatedGapSuggestionHelper } from "../../src/helper/isolation.js";
import {
  HostedCopilotHelperTransport,
  LocalOpenAiCompatibleHelperTransport
} from "../../src/helper/transports.js";
import {
  assessSecurity,
  authorizeExternalSend
} from "../../src/security/security.js";

const producer: ProducerMetadata = {
  producerId: "test.transport",
  kind: "helper-model",
  version: "1.0.0",
  digest: canonicalJsonDigest("test.transport")
};

const obligation = {
  obligationId: "obligation-1",
  kind: "referenced-source",
  key: "source",
  description: "Need source",
  status: "missing" as const,
  required: true,
  evidenceIds: ["evidence-1"],
  reasons: ["missing"],
  producer
};

function request() {
  return {
    runId: "run-1",
    obligations: [obligation],
    availableEvidenceIds: ["evidence-1"],
    maxSuggestions: 3,
    maxQueryCharacters: 200,
    maxPromptCharacters: 4_000,
    maxResponseBytes: 8_000,
    maxReasonCharacters: 500,
    maxEvidenceIdsPerSuggestion: 8,
    timeoutMs: 100
  };
}

class SequenceTransport implements IsolatedHelperTransport {
  readonly metadata = producer;
  readonly responses: (string | Error)[];
  calls = 0;

  constructor(responses: (string | Error)[]) {
    this.responses = responses;
  }

  async complete(): Promise<string> {
    const response = this.responses[this.calls];
    this.calls += 1;
    if (response instanceof Error) throw response;
    return response ?? "";
  }
}

describe("isolated additive-only evidence helper", () => {
  it("returns only schema-valid evidence-ID-bound suggestions", async () => {
    const helper = new IsolatedGapSuggestionHelper(
      new SequenceTransport([
        JSON.stringify({
          status: "suggestions",
          suggestions: [
            {
              obligationId: "obligation-1",
              query: "Read src/app.ts around the referenced line",
              reason: "The source obligation is missing",
              evidenceIds: ["evidence-1"]
            }
          ]
        })
      ])
    );
    const result = await helper.run(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("applied");
    expect(result.value.suggestions).toHaveLength(1);
  });

  it("uses one syntactic retry and otherwise becomes a no-op", async () => {
    const recoveredTransport = new SequenceTransport([
      "not-json",
      JSON.stringify({ status: "abstain", suggestions: [] })
    ]);
    const recovered = await new IsolatedGapSuggestionHelper(
      recoveredTransport
    ).run(request());
    expect(recovered.ok && recovered.value.reason).toBe("abstain");
    expect(recovered.ok && recovered.value.attempts).toBe(2);

    const malformed = await new IsolatedGapSuggestionHelper(
      new SequenceTransport(["{", "still-invalid"])
    ).run(request());
    expect(malformed.ok && malformed.value.reason).toBe("malformed");
    expect(malformed.ok && malformed.value.suggestions).toEqual([]);
  });

  it("treats unknown evidence IDs, refusal, timeout, and budget excess as no-ops", async () => {
    const invalid = await new IsolatedGapSuggestionHelper(
      new SequenceTransport([
        JSON.stringify({
          status: "suggestions",
          suggestions: [
            {
              obligationId: "obligation-1",
              query: "query",
              reason: "reason",
              evidenceIds: ["unknown"]
            }
          ]
        })
      ])
    ).run(request());
    expect(invalid.ok && invalid.value.reason).toBe("invalid-evidence");

    const refused = await new IsolatedGapSuggestionHelper(
      new SequenceTransport([
        JSON.stringify({ status: "refusal", suggestions: [] })
      ])
    ).run(request());
    expect(refused.ok && refused.value.reason).toBe("refusal");

    const timeout = await new IsolatedGapSuggestionHelper(
      new SequenceTransport([new Error("timeout")])
    ).run(request());
    expect(timeout.ok && timeout.value.reason).toBe("timeout");

    const budget = await new IsolatedGapSuggestionHelper(
      new SequenceTransport([])
    ).run({ ...request(), maxSuggestions: 99 });
    expect(budget.ok && budget.value.reason).toBe("budget");

    const oversized = await new IsolatedGapSuggestionHelper(
      new SequenceTransport(["x".repeat(9_000)])
    ).run(request());
    expect(oversized.ok && oversized.value.reason).toBe("budget");
  });

  it("restricts the OpenAI-compatible helper to loopback", async () => {
    expect(
      () =>
        new LocalOpenAiCompatibleHelperTransport({
          endpoint: "https://example.com/v1/chat/completions",
          model: "local"
        })
    ).toThrow();
    const transport = new LocalOpenAiCompatibleHelperTransport({
      endpoint: "http://127.0.0.1:1234/v1/chat/completions",
      model: "local",
      fetchImpl: async (_input, init) => {
        expect(init?.redirect).toBe("error");
        return (
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "{\"status\":\"abstain\"}" } }]
          }),
          { status: 200 }
        )
        );
      }
    });
    expect(await transport.complete("prompt", 100)).toContain("abstain");
    expect(
      () =>
        new LocalOpenAiCompatibleHelperTransport({
          endpoint: "http://[::1]:1234/v1/chat/completions",
          model: "local"
        })
    ).not.toThrow();
    expect(
      () =>
        new LocalOpenAiCompatibleHelperTransport({
          endpoint: "http://user:password@127.0.0.1:1234/v1/chat/completions",
          model: "local"
        })
    ).toThrow();
  });

  it("aborts an isolated hosted helper session on timeout", async () => {
    let aborted = false;
    const transport = new HostedCopilotHelperTransport(async () => ({
      start: async () => undefined,
      createSession: async () => ({
        sendAndWait: async () => new Promise(() => undefined),
        abort: async () => {
          aborted = true;
        },
        disconnect: async () => undefined
      }),
      stop: async () => []
    }));
    const prompt = "prompt";
    const bytes = Buffer.from(prompt, "utf8");
    const assessedSource = {
      sourceId: "helper-prompt",
      bytes,
      trustClass: "external-untrusted" as const
    };
    const assessment = assessSecurity([assessedSource]);
    const authorization = authorizeExternalSend({
      payload: bytes,
      assessment,
      explicitApproval: true,
      assessedSource
    });
    expect(authorization.ok).toBe(true);
    if (!authorization.ok) return;
    await expect(
      transport.complete(prompt, 5, {
        networkApproved: true,
        assessment,
        authorization: authorization.value,
        assessedSource
      })
    ).rejects.toThrow();
    expect(aborted).toBe(true);
  });

  it("rejects suggestions for obligations already satisfied in the shown snapshot", async () => {
    const helper = new IsolatedGapSuggestionHelper(
      new SequenceTransport([
        JSON.stringify({
          status: "suggestions",
          suggestions: [
            {
              obligationId: "obligation-1",
              query: "query",
              reason: "reason",
              evidenceIds: ["evidence-1"]
            }
          ]
        })
      ])
    );
    const result = await helper.run({
      ...request(),
      obligations: [{ ...obligation, status: "satisfied" }]
    });
    expect(result.ok && result.value.reason).toBe("invalid-evidence");
  });
});
