import { readFileSync } from "node:fs";

import type {
  CurrentSnapshotCapture,
  CurrentSourceReadPort
} from "../contracts/tui.js";
import type { ArtifactSnapshot } from "../contracts/types.js";
import { sha256Base64Url } from "../core/hash.js";
import { failure, success, type Result } from "../core/result.js";
import { snapshotBytes } from "../intake/intake.js";
import { renderContext } from "../render/render.js";

export class LocalFileCurrentSourcePort implements CurrentSourceReadPort {
  readonly #captured: readonly ArtifactSnapshot[];

  constructor(captured: readonly ArtifactSnapshot[]) {
    this.#captured = captured;
  }

  capture(): Result<CurrentSnapshotCapture> {
    const current: ArtifactSnapshot[] = [];
    for (const artifact of this.#captured) {
      if (
        artifact.source.kind !== "file" ||
        artifact.source.canonicalPath === undefined
      ) {
        return failure(
          "INVALID_ARGUMENT",
          "Current snapshot is unavailable for pasted artifacts",
          { artifactId: artifact.artifactId }
        );
      }
      try {
        const bytes = readFileSync(artifact.source.canonicalPath);
        const detected = snapshotBytes(bytes, {
          ordinal: artifact.ordinal,
          role: artifact.role,
          kind: "file",
          label: artifact.source.label,
          requestedPath:
            artifact.source.requestedPath ?? artifact.source.canonicalPath,
          canonicalPath: artifact.source.canonicalPath
        });
        if (detected.utf8 !== "valid") {
          return failure(
            "INVALID_UTF8",
            "Current source snapshot is not valid UTF-8",
            { artifactId: artifact.artifactId }
          );
        }
        current.push({ ...detected, artifactId: artifact.artifactId });
      } catch (error) {
        return failure("IO_ERROR", "Unable to recapture current source", {
          artifactId: artifact.artifactId,
          cause: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const bytes = renderContext(
      current,
      new Map<string, readonly never[]>(),
      []
    ).preparedBytes;
    return success({
      bytes,
      sourceIdentities: current.map((artifact) => ({
        sourceId: artifact.artifactId,
        identity: {
          sha256: sha256Base64Url(artifact.bytes),
          byteLength: artifact.byteLength
        }
      }))
    });
  }
}
