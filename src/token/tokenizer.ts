import { getEncoding } from "js-tiktoken";

import type { TokenMeasurement } from "../contracts/types.js";
import { failure, success, type Result } from "../core/result.js";

const encoding = getEncoding("o200k_base");

export function measureTokens(
  originalText: string,
  preparedText: string
): Result<TokenMeasurement> {
  try {
    return success({
      encoding: "o200k_base",
      kind: "actual",
      originalTokens: encoding.encode(originalText).length,
      preparedTokens: encoding.encode(preparedText).length
    });
  } catch (error) {
    return failure("TOKENIZER_ERROR", "Actual token measurement failed", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

