import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { prepareContext } from "./pipeline/prepare.js";
import { failure, success, type Result } from "./core/result.js";
import { ContextStore } from "./storage/store.js";
import { verifyStoredRun } from "./validate/validate.js";

export const HELP = `Context Overflow POC

Usage:
  context-overflow prepare --prompt-file <path> [--context <path> ...] [--store <path>] [--output <path>] [--max-artifact-bytes <n>] [--nearby <n>]
  context-overflow prepare --prompt-text <text> [--context <path> ...] [--store <path>] [--output <path>] [--max-artifact-bytes <n>] [--nearby <n>]
  context-overflow inspect --run <run-id> [--store <path>]
  context-overflow retrieve <handle> [--store <path>]
  context-overflow verify --run <run-id> [--store <path>]

Defaults:
  --store .context-overflow/context-overflow.sqlite

All prepared output is released only after transactional storage, real handle
readback, occurrence-specific evidence checks, actual token measurement, and
byte-identical reconstruction validation succeed.
`;

export interface CliIo {
  readonly stdout: (value: string | Uint8Array) => void;
  readonly stderr: (value: string | Uint8Array) => void;
}

interface ParsedArgs {
  readonly command?: string;
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, readonly string[]>;
}

function parseArgs(args: readonly string[]): Result<ParsedArgs> {
  const command = args[0];
  const options = new Map<string, string[]>();
  const positionals: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return failure("INVALID_ARGUMENT", `Missing value for ${token}`);
    }
    const key = token.slice(2);
    const existing = options.get(key) ?? [];
    existing.push(value);
    options.set(key, existing);
    index += 1;
  }
  return success({
    ...(command === undefined ? {} : { command }),
    positionals,
    options
  });
}

function oneOption(
  parsed: ParsedArgs,
  name: string,
  required = false
): Result<string | undefined> {
  const values = parsed.options.get(name) ?? [];
  if (values.length > 1) {
    return failure("INVALID_ARGUMENT", `Option --${name} may appear only once`);
  }
  if (required && values[0] === undefined) {
    return failure("INVALID_ARGUMENT", `Missing required option --${name}`);
  }
  return success(values[0]);
}

function defaultStore(parsed: ParsedArgs): Result<string> {
  const configured = oneOption(parsed, "store");
  if (!configured.ok) return configured;
  return success(
    resolve(
      configured.value ??
        ".context-overflow\\context-overflow.sqlite"
    )
  );
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function rejectUnknownOptions(
  parsed: ParsedArgs,
  allowed: readonly string[]
): Result<void> {
  const unknown = [...parsed.options.keys()].filter(
    (key) => !allowed.includes(key)
  );
  return unknown.length === 0
    ? success(undefined)
    : failure(
        "INVALID_ARGUMENT",
        `Unsupported option(s): ${unknown.map((key) => `--${key}`).join(", ")}`
      );
}

function positiveIntegerOption(
  parsed: ParsedArgs,
  name: string
): Result<number | undefined> {
  const option = oneOption(parsed, name);
  if (!option.ok) return option;
  if (option.value === undefined) return success(undefined);
  const value = Number(option.value);
  return Number.isSafeInteger(value) && value > 0
    ? success(value)
    : failure("INVALID_ARGUMENT", `--${name} must be a positive integer`);
}

async function runPrepare(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const known = rejectUnknownOptions(parsed, [
    "prompt-file",
    "prompt-text",
    "context",
    "store",
    "output",
    "max-artifact-bytes",
    "nearby"
  ]);
  const promptFile = oneOption(parsed, "prompt-file");
  const promptText = oneOption(parsed, "prompt-text");
  const output = oneOption(parsed, "output");
  const store = defaultStore(parsed);
  const maxArtifactBytes = positiveIntegerOption(
    parsed,
    "max-artifact-bytes"
  );
  const nearby = positiveIntegerOption(parsed, "nearby");
  if (!known.ok || parsed.positionals.length > 0) {
    io.stderr(
      `${
        known.ok
          ? "INVALID_ARGUMENT: prepare does not accept positional arguments"
          : `${known.error.code}: ${known.error.message}`
      }\n`
    );
    return 2;
  }
  if (!promptFile.ok) {
    io.stderr(`${promptFile.error.code}: ${promptFile.error.message}\n`);
    return 2;
  }
  if (!promptText.ok) {
    io.stderr(`${promptText.error.code}: ${promptText.error.message}\n`);
    return 2;
  }
  if (!output.ok) {
    io.stderr(`${output.error.code}: ${output.error.message}\n`);
    return 2;
  }
  if (!store.ok) {
    io.stderr(`${store.error.code}: ${store.error.message}\n`);
    return 2;
  }
  if (!maxArtifactBytes.ok) {
    io.stderr(
      `${maxArtifactBytes.error.code}: ${maxArtifactBytes.error.message}\n`
    );
    return 2;
  }
  if (!nearby.ok) {
    io.stderr(`${nearby.error.code}: ${nearby.error.message}\n`);
    return 2;
  }
  if ((promptFile.value === undefined) === (promptText.value === undefined)) {
    io.stderr(
      "INVALID_ARGUMENT: provide exactly one of --prompt-file or --prompt-text\n"
    );
    return 2;
  }

  const result = await prepareContext({
    ...(promptFile.value === undefined
      ? { promptText: promptText.value as string }
      : { promptFile: promptFile.value }),
    contextFiles: parsed.options.get("context") ?? [],
    storePath: store.value as string,
    ...(maxArtifactBytes.value === undefined
      ? {}
      : { maxArtifactBytes: maxArtifactBytes.value }),
    ...(nearby.value === undefined ? {} : { nearbySegments: nearby.value })
  });
  if (!result.ok) {
    io.stderr(
      `${result.error.code}: ${result.error.message}${
        result.error.details === undefined
          ? ""
          : `\n${JSON.stringify(result.error.details)}`
      }\n`
    );
    return 1;
  }
  if (output.value !== undefined) {
    try {
      await writeFile(resolve(output.value), result.value.package.preparedBytes);
    } catch (error) {
      io.stderr(
        `IO_ERROR: unable to write validated output: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
      return 1;
    }
  }
  writeJson(io, {
    runId: result.value.package.runId,
    store: store.value,
    output: output.value === undefined ? null : resolve(output.value),
    manifestSha256: result.value.package.manifestSha256,
    receipt: result.value.receipt,
    ...(output.value === undefined
      ? { preparedText: result.value.package.preparedText }
      : {})
  });
  return 0;
}

function withStore<T>(
  storePath: string,
  action: (store: ContextStore) => Result<T>
): Result<T> {
  let store: ContextStore;
  try {
    store = new ContextStore(storePath);
  } catch (error) {
    return failure("STORAGE_ERROR", "Unable to open durable SQLite store", {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
  try {
    return action(store);
  } finally {
    store.close();
  }
}

function runInspect(parsed: ParsedArgs, io: CliIo): number {
  const known = rejectUnknownOptions(parsed, ["run", "store"]);
  if (!known.ok || parsed.positionals.length > 0) {
    io.stderr(
      `${
        known.ok
          ? "INVALID_ARGUMENT: inspect does not accept positional arguments"
          : `${known.error.code}: ${known.error.message}`
      }\n`
    );
    return 2;
  }
  const run = oneOption(parsed, "run", true);
  const store = defaultStore(parsed);
  if (!run.ok) {
    io.stderr(`${run.error.code}: ${run.error.message}\n`);
    return 2;
  }
  if (!store.ok) {
    io.stderr(`${store.error.code}: ${store.error.message}\n`);
    return 2;
  }
  const receipt = withStore(store.value, (database) =>
    database.inspectReceipt(run.value as string)
  );
  if (!receipt.ok) {
    io.stderr(`${receipt.error.code}: ${receipt.error.message}\n`);
    return 1;
  }
  writeJson(io, receipt.value);
  return 0;
}

function runRetrieve(parsed: ParsedArgs, io: CliIo): number {
  const known = rejectUnknownOptions(parsed, ["store"]);
  if (!known.ok) {
    io.stderr(`${known.error.code}: ${known.error.message}\n`);
    return 2;
  }
  const store = defaultStore(parsed);
  const handle = parsed.positionals[0];
  if (!store.ok || handle === undefined || parsed.positionals.length !== 1) {
    io.stderr(
      !store.ok
        ? `${store.error.code}: ${store.error.message}\n`
        : "INVALID_ARGUMENT: retrieve requires exactly one handle\n"
    );
    return 2;
  }
  const retrieved = withStore(store.value, (database) =>
    database.retrieve(handle)
  );
  if (!retrieved.ok) {
    io.stderr(`${retrieved.error.code}: ${retrieved.error.message}\n`);
    return 1;
  }
  io.stdout(retrieved.value);
  return 0;
}

function runVerify(parsed: ParsedArgs, io: CliIo): number {
  const known = rejectUnknownOptions(parsed, ["run", "store"]);
  if (!known.ok || parsed.positionals.length > 0) {
    io.stderr(
      `${
        known.ok
          ? "INVALID_ARGUMENT: verify does not accept positional arguments"
          : `${known.error.code}: ${known.error.message}`
      }\n`
    );
    return 2;
  }
  const run = oneOption(parsed, "run", true);
  const store = defaultStore(parsed);
  if (!run.ok) {
    io.stderr(`${run.error.code}: ${run.error.message}\n`);
    return 2;
  }
  if (!store.ok) {
    io.stderr(`${store.error.code}: ${store.error.message}\n`);
    return 2;
  }
  const verified = withStore(store.value, (database) =>
    verifyStoredRun(database, run.value as string)
  );
  if (!verified.ok) {
    io.stderr(`${verified.error.code}: ${verified.error.message}\n`);
    return 1;
  }
  writeJson(io, {
    runId: verified.value.runId,
    status: "verified",
    reconstruction: "byte-identical",
    manifestSha256: verified.value.manifestSha256,
    compactSha256: verified.value.manifest.compactSha256,
    tokenizer: verified.value.manifest.tokenizer
  });
  return 0;
}

export async function runCli(
  args: readonly string[],
  io: CliIo = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value)
  }
): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    io.stdout(HELP);
    return 0;
  }
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    io.stderr(`${parsed.error.code}: ${parsed.error.message}\n`);
    return 2;
  }
  switch (parsed.value.command) {
    case "prepare":
      return runPrepare(parsed.value, io);
    case "inspect":
      return runInspect(parsed.value, io);
    case "retrieve":
      return runRetrieve(parsed.value, io);
    case "verify":
      return runVerify(parsed.value, io);
    default:
      io.stderr(`Unknown command: ${parsed.value.command ?? ""}\n\n${HELP}`);
      return 2;
  }
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntrypoint) {
  process.exitCode = await runCli(process.argv.slice(2));
}
