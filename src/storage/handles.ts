import { failure, success, type Result } from "../core/result.js";

export interface ParsedHandle {
  readonly digest: string;
  readonly byteLength: number;
  readonly occurrenceId: string;
}

const HANDLE_PATTERN =
  /^ctxo:v1:sha256:([A-Za-z0-9_-]{43}):(\d+):([A-Za-z0-9._-]+)$/;

export function createHandle(
  digest: string,
  byteLength: number,
  occurrenceId: string
): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(digest)) {
    throw new TypeError("Handle digest must be a full SHA-256 base64url digest");
  }
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new RangeError("Handle byte length must be a positive safe integer");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(occurrenceId)) {
    throw new TypeError("Handle occurrence ID contains unsupported characters");
  }
  return `ctxo:v1:sha256:${digest}:${byteLength}:${occurrenceId}`;
}

export function parseHandle(handle: string): Result<ParsedHandle> {
  const match = HANDLE_PATTERN.exec(handle);
  if (match === null) {
    return failure("HANDLE_INVALID", "Malformed Context Overflow handle", {
      handle
    });
  }
  const digest = match[1];
  const lengthText = match[2];
  const occurrenceId = match[3];
  if (
    digest === undefined ||
    lengthText === undefined ||
    occurrenceId === undefined
  ) {
    return failure("HANDLE_INVALID", "Incomplete Context Overflow handle", {
      handle
    });
  }
  const byteLength = Number(lengthText);
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    return failure("HANDLE_INVALID", "Invalid handle byte length", { handle });
  }
  return success({ digest, byteLength, occurrenceId });
}

