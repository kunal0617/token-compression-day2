import {
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  closeSync,
  fsyncSync,
  existsSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  basename,
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

export function validateCanonicalBenchmarkAnchor(
  lexicalRoot: string,
  workspaceRoot: string
): Result<string> {
  try {
    const stats = lstatSync(lexicalRoot);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return failure(
        "INTEGRITY_ERROR",
        "Benchmark root must be a workspace-owned real directory"
      );
    }
    const workspace = realpathSync(workspaceRoot);
    const canonical = realpathSync(lexicalRoot);
    const expected = resolve(workspace, ".context-overflow");
    return normalized(canonical) === normalized(expected)
      ? success(canonical)
      : failure(
          "INTEGRITY_ERROR",
          "Benchmark root resolves outside the workspace"
        );
  } catch (error) {
    return failure("IO_ERROR", "Unable to validate benchmark root", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

export function validatedBenchmarkRoot(): Result<string> {
  return validateCanonicalBenchmarkAnchor(
    benchmarkRoot(),
    process.cwd()
  );
}

export function validatedContainedRoot(
  root: string
): Result<string> {
  const benchmark = validatedBenchmarkRoot();
  if (!benchmark.ok) return benchmark;
  try {
    const lexical = resolve(root);
    const stats = lstatSync(lexical);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return failure(
        "INTEGRITY_ERROR",
        "Benchmark contained root must be a real directory"
      );
    }
    const canonical = realpathSync(lexical);
    const child = relative(benchmark.value, canonical);
    return !child.startsWith("..") && !isAbsolute(child)
      ? success(canonical)
      : failure(
          "INTEGRITY_ERROR",
          "Benchmark contained root resolves outside .context-overflow"
        );
  } catch (error) {
    return failure(
      "IO_ERROR",
      "Unable to validate benchmark contained root",
      {
        cause: error instanceof Error ? error.message : String(error)
      }
    );
  }
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
    const root = validatedBenchmarkRoot();
    if (!root.ok) return root;
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
    return validatedContainedRoot(absolute);
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
    const containedRoot = validatedContainedRoot(root);
    if (!containedRoot.ok) return containedRoot;
    const canonicalRoot = containedRoot.value;
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
  const temporary = resolve(
    dirname(resolved.value),
    `.${basename(resolved.value)}.${randomUUID()}.tmp`
  );
  try {
    mkdirSync(dirname(resolved.value), { recursive: true });
    const fd = openSync(temporary, "wx");
    try {
      writeFileSync(
        fd,
        `${canonicalJson(value)}\n`,
        "utf8"
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, resolved.value);
    return success(undefined);
  } catch (error) {
    rmSync(temporary, { force: true });
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

export function writeBytesAtomic(
  root: string,
  relativePath: string,
  bytes: Buffer
): Result<void> {
  const resolved = resolveInside(root, relativePath);
  if (!resolved.ok) return resolved;
  const temporary = resolve(
    dirname(resolved.value),
    `.${basename(resolved.value)}.${randomUUID()}.tmp`
  );
  try {
    mkdirSync(dirname(resolved.value), { recursive: true });
    const fd = openSync(temporary, "wx");
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, resolved.value);
    return success(undefined);
  } catch (error) {
    rmSync(temporary, { force: true });
    return failure(
      "IO_ERROR",
      "Unable to atomically write benchmark file",
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
  if (!insideBenchmarkRoot(absolute)) {
    return failure(
        "INTEGRITY_ERROR",
        "Benchmark index path escapes .context-overflow"
      );
  }
  try {
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return failure(
        "INTEGRITY_ERROR",
        "Benchmark indexed run is not a real directory"
      );
    }
    const benchmark = validatedBenchmarkRoot();
    if (!benchmark.ok) return benchmark;
    const canonicalRoot = benchmark.value;
    const canonical = realpathSync(absolute);
    const child = relative(canonicalRoot, canonical);
    return !child.startsWith("..") && !isAbsolute(child)
      ? success(canonical)
      : failure(
          "INTEGRITY_ERROR",
          "Benchmark indexed run resolves outside .context-overflow"
        );
  } catch {
    return failure(
      "HANDLE_NOT_FOUND",
      "Benchmark indexed run is unavailable"
    );
  }
}

export function directoryIsEmpty(path: string): boolean {
  try {
    return statSync(path).isDirectory() &&
      readdirSync(path).length === 0;
  } catch {
    return false;
  }
}
