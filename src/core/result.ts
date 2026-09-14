export interface ContextOverflowError {
  readonly code:
    | "INVALID_ARGUMENT"
    | "LIMIT_EXCEEDED"
    | "INVALID_UTF8"
    | "IO_ERROR"
    | "CLASSIFICATION_ERROR"
    | "STORAGE_ERROR"
    | "HANDLE_INVALID"
    | "HANDLE_NOT_FOUND"
    | "INTEGRITY_ERROR"
    | "TOKENIZER_ERROR"
    | "RUN_NOT_COMMITTED"
    | "INTERNAL_ERROR";
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ContextOverflowError };

export function success<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function failure(
  code: ContextOverflowError["code"],
  message: string,
  details?: Readonly<Record<string, unknown>>
): Result<never> {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } };
}

