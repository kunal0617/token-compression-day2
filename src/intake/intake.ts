import { open, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { TextDecoder } from "node:util";

import type {
  ArtifactRole,
  ArtifactSnapshot,
  NewlineStyle
} from "../contracts/types.js";
import { sha256Base64Url, sha256Text } from "../core/hash.js";
import { failure, success, type Result } from "../core/result.js";

export const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

export interface IntakeOptions {
  readonly maxArtifactBytes?: number;
}

function detectUtf8(bytes: Buffer): "valid" | "invalid" {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "valid";
  } catch (error) {
    if (error instanceof TypeError) {
      return "invalid";
    }
    throw error;
  }
}

function detectNewlineStyle(bytes: Buffer): NewlineStyle {
  let lf = 0;
  let crlf = 0;
  let cr = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0d) {
      if (bytes[index + 1] === 0x0a) {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
    } else if (bytes[index] === 0x0a) {
      lf += 1;
    }
  }

  const styles = [lf > 0, crlf > 0, cr > 0].filter(Boolean).length;
  if (styles === 0) return "none";
  if (styles > 1) return "mixed";
  if (crlf > 0) return "crlf";
  if (cr > 0) return "cr";
  return "lf";
}

export function snapshotBytes(
  bytes: Buffer,
  input: {
    readonly ordinal: number;
    readonly role: ArtifactRole;
    readonly kind: "file" | "pasted";
    readonly label: string;
    readonly requestedPath?: string;
    readonly canonicalPath?: string;
    readonly completeness?: "complete" | "truncated" | "unknown";
    readonly completenessReason?: string;
  }
): ArtifactSnapshot {
  const sha256 = sha256Base64Url(bytes);
  const source =
    input.requestedPath === undefined
      ? { kind: input.kind, label: input.label }
      : {
          kind: input.kind,
          label: input.label,
          requestedPath: input.requestedPath,
          canonicalPath: input.canonicalPath ?? input.requestedPath
        };

  return {
    artifactId: `artifact:${sha256Text(
      `${input.ordinal}:${input.role}:${input.label}:${sha256}`
    )}`,
    ordinal: input.ordinal,
    role: input.role,
    source,
    bytes: Buffer.from(bytes),
    byteLength: bytes.length,
    sha256,
    utf8: detectUtf8(bytes),
    hasBom:
      bytes.length >= 3 &&
      bytes[0] === 0xef &&
      bytes[1] === 0xbb &&
      bytes[2] === 0xbf,
    newlineStyle: detectNewlineStyle(bytes),
    hasAnsi: /\u001b\[[0-?]*[ -/]*[@-~]/u.test(bytes.toString("utf8")),
    completeness: input.completeness ?? "complete",
    completenessReason:
      input.completenessReason ?? "captured-entire-input-without-normalization"
  };
}

export function intakePastedText(
  text: string,
  input: {
    readonly ordinal: number;
    readonly role: ArtifactRole;
    readonly label: string;
  },
  options: IntakeOptions = {}
): Result<ArtifactSnapshot> {
  const bytes = Buffer.from(text, "utf8");
  const limit = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  if (bytes.length > limit) {
    return failure("LIMIT_EXCEEDED", "Pasted artifact exceeds byte limit", {
      label: input.label,
      byteLength: bytes.length,
      limit
    });
  }
  return success(
    snapshotBytes(bytes, {
      ...input,
      kind: "pasted"
    })
  );
}

export async function intakeUtf8File(
  path: string,
  input: {
    readonly ordinal: number;
    readonly role: ArtifactRole;
    readonly label?: string;
  },
  options: IntakeOptions = {}
): Promise<Result<ArtifactSnapshot>> {
  const absolutePath = resolve(path);
  const limit = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  let handle;
  try {
    const canonicalPath = await realpath(absolutePath);
    handle = await open(canonicalPath, "r");
    const before = await handle.stat();
    if (before.size > limit) {
      return failure("LIMIT_EXCEEDED", "File exceeds byte limit", {
        path: absolutePath,
        byteLength: before.size,
        limit
      });
    }

    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      bytes.length !== after.size
    ) {
      return failure("IO_ERROR", "File changed during raw-byte capture", {
        path: absolutePath
      });
    }

    const snapshot = snapshotBytes(bytes, {
      ordinal: input.ordinal,
      role: input.role,
      kind: "file",
      label: input.label ?? basename(absolutePath),
      requestedPath: absolutePath,
      canonicalPath
    });
    if (snapshot.utf8 === "invalid") {
      return failure("INVALID_UTF8", "Input file is not valid UTF-8", {
        path: absolutePath,
        sha256: snapshot.sha256,
        byteLength: snapshot.byteLength
      });
    }
    return success(snapshot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure("IO_ERROR", "Unable to capture input file", {
      path: absolutePath,
      cause: message
    });
  } finally {
    await handle?.close();
  }
}
