import {
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  closeSync,
  fsyncSync,
  existsSync
} from "node:fs";
import {
  dirname,
  isAbsolute,
  relative,
  resolve
} from "node:path";

import { canonicalJson } from "../core/canonical.js";
import { sha256Base64Url } from "../core/hash.js";
import { failure, success, type Result } from "../core/result.js";

function normalized(path: string): string {
  const value = resolve(path);
  return process.platform === "win32"
    ? value.toLowerCase()
    : value;
}

export function benchmarkRoot(): string {
  return resolve(".context-overflow");
}

export function insideBenchmarkRoot(path: string): boolean {
  const root = normalized(benchmarkRoot());
  const target = normalized(path);
  const child = relative(root, target);
  return (
    child.length === 0 ||
    (!child.startsWith("..") && !isAbsolute(child))
  );
}

export function prepareOutputDirectory(
  path: string,
  options: { readonly allowExisting: boolean }
): Result<string> {
  const absolute = resolve(path);
  if (!insideBenchmarkRoot(absolute)) {
    return failure(
      "INVALID_ARGUMENT",
      "Benchmark output must be beneath .context-overflow"
    );
  }
  try {
    mkdirSync(benchmarkRoot(), { recursive: true });
    const root = realpathSync(benchmarkRoot());
    if (!insideBenchmarkRoot(root)) {
      return failure(
        "INTEGRITY_ERROR",
        "Benchmark root resolution escaped the workspace"
      );
    }
    try {
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        return failure(
          "INVALID_ARGUMENT",
          "Benchmark output must be a real directory"
        );
      }
      if (!options.allowExisting) {
        return failure(
          "INVALID_ARGUMENT",
          "Benchmark output already exists"
        );
      }
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        return failure(
          "IO_ERROR",
          "Unable to inspect benchmark output"
        );
      }
      const relativePath = relative(benchmarkRoot(), absolute);
      const safe = resolveInside(benchmarkRoot(), relativePath);
      if (!safe.ok) return safe;
      mkdirSync(absolute, { recursive: true });
    }
    const canonical = realpathSync(absolute);
    if (!insideBenchmarkRoot(canonical)) {
      return failure(
        "INTEGRITY_ERROR",
        "Benchmark output resolution escaped .context-overflow"
      );
    }
    return success(canonical);
  } catch (error) {
    return failure("IO_ERROR", "Unable to prepare benchmark output", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

export function resolveInside(
  root: string,
  relativePath: string
): Result<string> {
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath.includes("\0")
  ) {
    return failure(
      "INVALID_ARGUMENT",
      "Benchmark relative path is invalid"
    );
  }
  const absolute = resolve(root, relativePath);
  const child = relative(resolve(root), absolute);
  if (child.startsWith("..") || isAbsolute(child)) {
    return failure(
        "INTEGRITY_ERROR",
        "Benchmark path escapes its root"
      );
  }
  try {
    const canonicalRoot = realpathSync(root);
    let cursor = absolute;
    while (!existsSync(cursor)) {
      const parent = dirname(cursor);
      if (parent === cursor) {
        return failure(
          "INTEGRITY_ERROR",
          "Benchmark path has no existing parent"
        );
      }
      cursor = parent;
    }
    const canonicalParent = realpathSync(cursor);
    const canonicalChild = relative(
      canonicalRoot,
      canonicalParent
    );
    return !canonicalChild.startsWith("..") &&
      !isAbsolute(canonicalChild)
      ? success(absolute)
      : failure(
          "INTEGRITY_ERROR",
          "Benchmark path resolves outside its root"
        );
  } catch (error) {
    return failure("IO_ERROR", "Unable to resolve benchmark path", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

export function writeNewBytes(
  root: string,
  relativePath: string,
  bytes: Buffer
): Result<{
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}> {
  const resolved = resolveInside(root, relativePath);
  if (!resolved.ok) return resolved;
  try {
    mkdirSync(dirname(resolved.value), { recursive: true });
    const fd = openSync(resolved.value, "wx");
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return success({
      path: relativePath.replaceAll("\\", "/"),
      sha256: sha256Base64Url(bytes),
      byteLength: bytes.length
    });
  } catch (error) {
    return failure("IO_ERROR", "Unable to write benchmark file", {
      path: relativePath,
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

export function writeCanonicalNew(
  root: string,
  relativePath: string,
  value: unknown
) {
  return writeNewBytes(
    root,
    relativePath,
    Buffer.from(`${canonicalJson(value)}\n`, "utf8")
  );
}

export function writeCanonicalAtomic(
  root: string,
  relativePath: string,
  value: unknown
): Result<void> {
  const resolved = resolveInside(root, relativePath);
  if (!resolved.ok) return resolved;
  const temporary = `${resolved.value}.tmp`;
  try {
    mkdirSync(dirname(resolved.value), { recursive: true });
    writeFileSync(
      temporary,
      `${canonicalJson(value)}\n`,
      { encoding: "utf8", flag: "w" }
    );
    renameSync(temporary, resolved.value);
    return success(undefined);
  } catch (error) {
    return failure(
      "IO_ERROR",
      "Unable to atomically write benchmark state",
      {
        path: relativePath,
        cause: error instanceof Error ? error.message : String(error)
      }
    );
  }
}

export function readBoundBytes(
  root: string,
  identity: {
    readonly path: string;
    readonly sha256: string;
    readonly byteLength: number;
  }
): Result<Buffer> {
  const resolved = resolveInside(root, identity.path);
  if (!resolved.ok) return resolved;
  try {
    const stats = lstatSync(resolved.value);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return failure(
        "INTEGRITY_ERROR",
        "Benchmark artifact is not a regular file"
      );
    }
    const bytes = readFileSync(resolved.value);
    if (
      bytes.length !== identity.byteLength ||
      sha256Base64Url(bytes) !== identity.sha256
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Benchmark artifact changed after export"
      );
    }
    return success(bytes);
  } catch (error) {
    return failure("IO_ERROR", "Unable to read benchmark artifact", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

export function relativeToBenchmarkRoot(path: string): string {
  return relative(benchmarkRoot(), resolve(path)).replaceAll("\\", "/");
}

export function benchmarkPathFromRelative(
  path: string
): Result<string> {
  if (isAbsolute(path)) {
    return failure(
      "INVALID_ARGUMENT",
      "Benchmark index contains an absolute path"
    );
  }
  const absolute = resolve(benchmarkRoot(), path);
  return insideBenchmarkRoot(absolute)
    ? success(absolute)
    : failure(
        "INTEGRITY_ERROR",
        "Benchmark index path escapes .context-overflow"
      );
}

export function directoryIsEmpty(path: string): boolean {
  try {
    return statSync(path).isDirectory() &&
      readdirSync(path).length === 0;
  } catch {
    return false;
  }
}
