import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

import type {
  BenchmarkCaseContract,
  BenchmarkExportCase,
  BenchmarkFileIdentity,
  BenchmarkRunState,
  BenchmarkSuite
} from "./contracts.js";
import {
  benchmarkPathFromRelative,
  benchmarkRoot,
  insideBenchmarkRoot,
  prepareOutputDirectory,
  readBoundBytes,
  relativeToBenchmarkRoot,
  resolveInside,
  writeCanonicalAtomic,
  writeCanonicalNew
} from "./io.js";
import {
  canonicalJson,
  canonicalJsonDigest
} from "../core/canonical.js";
import { failure, success, type Result } from "../core/result.js";

function parseCanonical<T>(
  bytes: Buffer,
  kind: string
): Result<T> {
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as T;
    if (`${canonicalJson(parsed)}\n` !== bytes.toString("utf8")) {
      return failure(
        "INTEGRITY_ERROR",
        `${kind} is not canonical`
      );
    }
    return success(parsed);
  } catch (error) {
    return failure("INTEGRITY_ERROR", `${kind} is invalid JSON`, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

function validateIdentity(
  root: string,
  identity: BenchmarkFileIdentity
): Result<void> {
  const bytes = readBoundBytes(root, identity);
  return bytes.ok ? success(undefined) : bytes;
}

function validateCase(
  root: string,
  item: BenchmarkExportCase
): Result<void> {
  const { digest, ...unsigned } = item;
  if (
    digest !== canonicalJsonDigest(unsigned) ||
    item.runId.length === 0 ||
    item.storePath.length === 0 ||
    !["ready", "failed", "gather-evidence"].includes(
      item.readiness
    )
  ) {
    return failure(
      "INTEGRITY_ERROR",
      "Benchmark export case metadata is invalid"
    );
  }
  for (const identity of [
    item.original,
    item.prepared,
    item.receipt,
    item.contractFile
  ]) {
    const valid = validateIdentity(root, identity);
    if (!valid.ok) return valid;
  }
  const store = resolveInside(root, item.storePath);
  if (!store.ok) return store;
  try {
    const stats = lstatSync(store.value);
    return stats.isFile() && !stats.isSymbolicLink()
      ? success(undefined)
      : failure(
          "INTEGRITY_ERROR",
          "Benchmark case store is not a regular file"
        );
  } catch {
    return failure(
      "IO_ERROR",
      "Benchmark case store is unavailable"
    );
  }
}

export function loadBenchmarkSuite(
  suitePath: string
): Result<{
  readonly root: string;
  readonly suite: BenchmarkSuite;
}> {
  const root = resolve(suitePath);
  if (!insideBenchmarkRoot(root)) {
    return failure(
      "INVALID_ARGUMENT",
      "Benchmark suite must be beneath .context-overflow"
    );
  }
  const manifestPath = resolve(root, "benchmark-suite.json");
  try {
    const stats = lstatSync(manifestPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return failure(
        "INTEGRITY_ERROR",
        "Benchmark suite manifest is not a regular file"
      );
    }
    const parsed = parseCanonical<BenchmarkSuite>(
      readFileSync(manifestPath),
      "Benchmark suite"
    );
    if (!parsed.ok) return parsed;
    const { digest, ...unsigned } = parsed.value;
    if (
      digest !== canonicalJsonDigest(unsigned) ||
      parsed.value.formatVersion !== 1 ||
      new Set(parsed.value.selectedCases).size !==
        parsed.value.selectedCases.length ||
      parsed.value.cases.length !==
        parsed.value.selectedCases.length
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Benchmark suite digest or case set is invalid"
      );
    }
    for (const item of parsed.value.cases) {
      const valid = validateCase(root, item);
      if (!valid.ok) return valid;
    }
    return success({ root, suite: parsed.value });
  } catch (error) {
    return failure("IO_ERROR", "Unable to load benchmark suite", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

export function loadCaseContract(
  suiteRoot: string,
  item: BenchmarkExportCase
): Result<BenchmarkCaseContract> {
  const bytes = readBoundBytes(suiteRoot, item.contractFile);
  if (!bytes.ok) return bytes;
  const parsed = parseCanonical<BenchmarkCaseContract>(
    bytes.value,
    "Benchmark case contract"
  );
  if (!parsed.ok) return parsed;
  const { digest, ...unsigned } = parsed.value;
  return digest === canonicalJsonDigest(unsigned) &&
    parsed.value.caseId === item.caseId
    ? parsed
    : failure(
        "INTEGRITY_ERROR",
        "Benchmark case contract digest is invalid"
      );
}

export function loadRunState(
  outputRoot: string
): Result<BenchmarkRunState | undefined> {
  const path = resolve(outputRoot, "benchmark-run.json");
  if (!existsSync(path)) return success(undefined);
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return failure(
        "INTEGRITY_ERROR",
        "Benchmark run state is not a regular file"
      );
    }
    const parsed = parseCanonical<BenchmarkRunState>(
      readFileSync(path),
      "Benchmark run state"
    );
    if (!parsed.ok) return parsed;
    const { digest, ...unsigned } = parsed.value;
    return digest === canonicalJsonDigest(unsigned)
      ? parsed
      : failure(
          "INTEGRITY_ERROR",
          "Benchmark run state digest is invalid"
        );
  } catch (error) {
    return failure("IO_ERROR", "Unable to load benchmark run state", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

export function saveRunState(
  outputRoot: string,
  state: Omit<BenchmarkRunState, "digest">
): Result<BenchmarkRunState> {
  const value: BenchmarkRunState = {
    ...state,
    digest: canonicalJsonDigest(state)
  };
  const written = writeCanonicalAtomic(
    outputRoot,
    "benchmark-run.json",
    value
  );
  return written.ok ? success(value) : written;
}

export function prepareRunDirectory(
  output: string
): Result<string> {
  return prepareOutputDirectory(output, {
    allowExisting: true
  });
}

export function registerBenchmarkRun(
  outputRoot: string,
  runId: string
): Result<void> {
  const indexRoot = resolve(benchmarkRoot(), "benchmark-index");
  try {
    mkdirSync(indexRoot, { recursive: true });
  } catch (error) {
    return failure("IO_ERROR", "Unable to create benchmark index", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  const relativePath = relativeToBenchmarkRoot(outputRoot);
  if (relativePath.length === 0 || relativePath.startsWith("..")) {
    return failure(
      "INTEGRITY_ERROR",
      "Benchmark run cannot be indexed outside .context-overflow"
    );
  }
  const index = {
    formatVersion: 1,
    runId,
    runPath: relativePath,
    digest: canonicalJsonDigest({
      formatVersion: 1,
      runId,
      runPath: relativePath
    })
  };
  const existing = resolve(indexRoot, `${runId}.json`);
  if (existsSync(existing)) {
    const parsed = parseCanonical<typeof index>(
      readFileSync(existing),
      "Benchmark index"
    );
    return parsed.ok &&
      canonicalJson(parsed.value) === canonicalJson(index)
      ? success(undefined)
      : failure(
          "INTEGRITY_ERROR",
          "Benchmark run ID is already registered elsewhere"
        );
  }
  const written = writeCanonicalNew(
    indexRoot,
    `${runId}.json`,
    index
  );
  return written.ok ? success(undefined) : written;
}

export function locateBenchmarkRun(
  runId: string
): Result<string> {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) {
    return failure(
      "INVALID_ARGUMENT",
      "Benchmark run ID is invalid"
    );
  }
  const indexPath = resolve(
    benchmarkRoot(),
    "benchmark-index",
    `${runId}.json`
  );
  try {
    const parsed = parseCanonical<{
      formatVersion: number;
      runId: string;
      runPath: string;
      digest: string;
    }>(
      readFileSync(indexPath),
      "Benchmark index"
    );
    if (!parsed.ok) return parsed;
    const { digest, ...unsigned } = parsed.value;
    if (
      digest !== canonicalJsonDigest(unsigned) ||
      parsed.value.runId !== runId
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Benchmark index digest is invalid"
      );
    }
    return benchmarkPathFromRelative(parsed.value.runPath);
  } catch {
    return failure(
      "HANDLE_NOT_FOUND",
      "Benchmark run was not found"
    );
  }
}

export function suiteDisplayName(path: string): string {
  return basename(resolve(path));
}
