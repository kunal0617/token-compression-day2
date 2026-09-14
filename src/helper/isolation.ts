import { z } from "zod";

import type {
  GapSuggestion,
  GapSuggestionRequest,
  GapSuggestionResult,
  IsolatedHelperTransport
} from "../contracts/helper.js";
import type {
  HelperModelAdapter,
  ProducerMetadata
} from "../contracts/providers.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import { deterministicUuid } from "../core/hash.js";
import { success, type Result } from "../core/result.js";

const responseSchema = z
  .object({
    status: z.enum(["suggestions", "abstain", "refusal"]),
    suggestions: z
      .array(
        z
          .object({
            obligationId: z.string().min(1),
            query: z.string().min(1),
            reason: z.string().min(1),
            evidenceIds: z.array(z.string())
          })
          .strict()
      )
      .default([])
  })
  .strict();

function producer(): ProducerMetadata {
  const producerId = "optional.helper.gap-suggestion-coordinator";
  const version = "1.0.0";
  return {
    producerId,
    kind: "helper-model",
    version,
    digest: canonicalJsonDigest({
      producerId,
      version,
      contract: [
        "additive-only",
        "no-tools",
        "no-files",
        "no-session-reentry",
        "one-syntax-retry",
        "strict-evidence-ids",
        "budgeted"
      ]
    })
  };
}

function promptFor(request: GapSuggestionRequest): string {
  return JSON.stringify({
    instruction:
      "Suggest bounded evidence retrieval queries only. Do not answer the task. Use only listed obligation and evidence IDs. Return JSON.",
    runId: request.runId,
    obligations: request.obligations
      .filter((obligation) => obligation.status !== "satisfied")
      .map((obligation) => ({
        obligationId: obligation.obligationId,
        kind: obligation.kind,
        status: obligation.status,
        description: obligation.description,
        evidenceIds: obligation.evidenceIds
      })),
    availableEvidenceIds: request.availableEvidenceIds,
    schema: {
      status: "suggestions|abstain|refusal",
      suggestions: [
        {
          obligationId: "string",
          query: "string",
          reason: "string",
          evidenceIds: ["string"]
        }
      ]
    }
  });
}

function noOp(
  producerMetadata: ProducerMetadata,
  reason: GapSuggestionResult["reason"],
  attempts: number
): Result<GapSuggestionResult> {
  return success({
    status: "no-op",
    reason,
    suggestions: [],
    attempts,
    producer: producerMetadata
  });
}

export class IsolatedGapSuggestionHelper
  implements HelperModelAdapter<GapSuggestionRequest, GapSuggestion>
{
  readonly metadata = producer();
  readonly #transport: IsolatedHelperTransport;

  constructor(transport: IsolatedHelperTransport) {
    this.#transport = transport;
  }

  async suggest(
    request: GapSuggestionRequest
  ): Promise<Result<readonly GapSuggestion[]>> {
    const result = await this.run(request);
    return result.ok ? success(result.value.suggestions) : result;
  }

  async run(
    request: GapSuggestionRequest
  ): Promise<Result<GapSuggestionResult>> {
    if (
      request.maxSuggestions <= 0 ||
      request.maxSuggestions > 8 ||
      request.maxQueryCharacters <= 0 ||
      request.maxQueryCharacters > 1_000 ||
      request.timeoutMs <= 0
    ) {
      return noOp(this.metadata, "budget", 0);
    }
    const prompt = promptFor(request);
    if (prompt.length > request.maxPromptCharacters) {
      return noOp(this.metadata, "budget", 0);
    }
    const obligationIds = new Set(
      request.obligations.map((obligation) => obligation.obligationId)
    );
    const evidenceIds = new Set(request.availableEvidenceIds);
    let attempts = 0;
    for (; attempts < 2; attempts += 1) {
      let raw: string;
      try {
        raw = await this.#transport.complete(prompt, request.timeoutMs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return noOp(
          this.metadata,
          /timeout|abort/i.test(message) ? "timeout" : "refusal",
          attempts + 1
        );
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        continue;
      }
      const parsed = responseSchema.safeParse(parsedJson);
      if (!parsed.success) continue;
      if (parsed.data.status === "abstain") {
        return noOp(this.metadata, "abstain", attempts + 1);
      }
      if (parsed.data.status === "refusal") {
        return noOp(this.metadata, "refusal", attempts + 1);
      }
      if (parsed.data.suggestions.length > request.maxSuggestions) {
        return noOp(this.metadata, "budget", attempts + 1);
      }
      const suggestions: GapSuggestion[] = [];
      for (const suggestion of parsed.data.suggestions) {
        if (
          !obligationIds.has(suggestion.obligationId) ||
          suggestion.query.length > request.maxQueryCharacters ||
          suggestion.evidenceIds.some(
            (evidenceId) => !evidenceIds.has(evidenceId)
          )
        ) {
          return noOp(this.metadata, "invalid-evidence", attempts + 1);
        }
        suggestions.push({
          suggestionId: deterministicUuid(
            `${request.runId}:${suggestion.obligationId}:${suggestion.query}`
          ),
          obligationId: suggestion.obligationId,
          query: suggestion.query,
          reason: suggestion.reason,
          evidenceIds: suggestion.evidenceIds
        });
      }
      return success({
        status: "applied",
        reason: "suggestions",
        suggestions,
        attempts: attempts + 1,
        producer: this.metadata
      });
    }
    return noOp(this.metadata, "malformed", attempts);
  }
}

export const isolatedGapSuggestionProducer = Object.freeze({
  metadata: producer()
});
