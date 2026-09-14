import type { EvidenceObligation } from "./providers.js";
import type { ProducerMetadata } from "./providers.js";

export interface GapSuggestionRequest {
  readonly runId: string;
  readonly obligations: readonly EvidenceObligation[];
  readonly availableEvidenceIds: readonly string[];
  readonly maxSuggestions: number;
  readonly maxQueryCharacters: number;
  readonly maxPromptCharacters: number;
  readonly timeoutMs: number;
}

export interface GapSuggestion {
  readonly suggestionId: string;
  readonly obligationId: string;
  readonly query: string;
  readonly reason: string;
  readonly evidenceIds: readonly string[];
}

export interface GapSuggestionResult {
  readonly status: "applied" | "no-op";
  readonly reason:
    | "suggestions"
    | "abstain"
    | "refusal"
    | "timeout"
    | "malformed"
    | "invalid-evidence"
    | "budget";
  readonly suggestions: readonly GapSuggestion[];
  readonly attempts: number;
  readonly producer: ProducerMetadata;
}

export interface IsolatedHelperTransport {
  readonly metadata: ProducerMetadata;
  complete(prompt: string, timeoutMs: number): Promise<string>;
}

