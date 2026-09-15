import {
  mkdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  BenchmarkCaseContract,
  BenchmarkCaseId,
  BenchmarkExportCase,
  BenchmarkFact,
  BenchmarkFileIdentity,
  BenchmarkSuite
} from "./contracts.js";
import {
  benchmarkCaseIds
} from "./contracts.js";
import {
  prepareOutputDirectory,
  writeCanonicalNew,
  writeNewBytes
} from "./io.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import {
  deterministicUuid,
  sha256Base64Url
} from "../core/hash.js";
import { failure, success, type Result } from "../core/result.js";
import {
  ExternalManualParityAdapter,
  type ManualBenchmarkInput
} from "../evaluation/manual-parity.js";
import { snapshotBytes } from "../intake/intake.js";
import { classifyArtifact, determineOutcome } from "../classify/classify.js";
import { extractEvidence } from "../evidence/extract.js";
import { typedFailureParsers } from "../parsers/failures.js";
import { prepareContext } from "../pipeline/prepare.js";
import { renderContext } from "../render/render.js";
import { ContextStore } from "../storage/store.js";
import {
  snapshotsFromManifest,
  verifyStoredRun
} from "../validate/validate.js";

function selectedCaseIds(
  selected?: readonly string[]
): Result<readonly BenchmarkCaseId[]> {
  const values =
    selected === undefined || selected.length === 0
      ? [...benchmarkCaseIds]
      : [...new Set(selected)];
  const invalid = values.filter(
    (value) =>
      !benchmarkCaseIds.includes(value as BenchmarkCaseId)
  );
  return invalid.length === 0
    ? success(values as BenchmarkCaseId[])
    : failure(
        "INVALID_ARGUMENT",
        `Unknown benchmark case(s): ${invalid.join(", ")}`
      );
}

function fact(
  caseId: BenchmarkCaseId,
  label: string,
  value: string,
  kind: BenchmarkFact["kind"],
  required = true
): BenchmarkFact | undefined {
  const normalized = value.trim();
  if (normalized.length < 2 || normalized.length > 2_000) {
    return undefined;
  }
  return {
    factId: deterministicUuid(
      `${caseId}:${kind}:${label}:${normalized}`
    ),
    label,
    value: normalized,
    valueSha256: sha256Base64Url(
      Buffer.from(normalized, "utf8")
    ),
    kind,
    required
  };
}

function collectFacts(input: ManualBenchmarkInput): BenchmarkFact[] {
  const values: BenchmarkFact[] = [];
  const add = (
    label: string,
    value: string | undefined,
    kind: BenchmarkFact["kind"],
    required = true
  ) => {
    if (value === undefined) return;
    const created = fact(
      input.caseId,
      label,
      value,
      kind,
      required
    );
    if (created !== undefined) values.push(created);
  };

  for (const [ordinal, source] of input.artifacts.entries()) {
    const artifact = snapshotBytes(source.bytes, {
      ordinal,
      role: "context",
      kind: "pasted",
      label: source.label
    });
    const classification = classifyArtifact(artifact);
    const evidence = extractEvidence(
      artifact,
      classification,
      determineOutcome([artifact])
    );
    for (const span of evidence) {
      if (
        [
          "failing-test",
          "exception",
          "compiler-diagnostic",
          "exit-code",
          "final-summary",
          "ci-critical"
        ].includes(span.kind)
      ) {
        add(
          `${span.kind}:${span.evidenceId}`,
          span.textPreview,
          span.kind === "failing-test" ||
            span.kind === "exception" ||
            span.kind === "compiler-diagnostic"
            ? "failure"
            : "evidence"
        );
      }
    }
    const reports = typedFailureParsers.parse(artifact);
    if (reports.ok) {
      for (const report of reports.value) {
        for (const test of report.tests) {
          add(`test:${test.testName}`, test.testName, "failure");
          add(
            `expected:${test.testName}`,
            test.expected,
            "expected"
          );
          add(
            `actual:${test.testName}`,
            test.actual,
            "actual"
          );
          if (test.location !== undefined) {
            add(
              `citation:${test.testName}`,
              `${test.location.path}:${test.location.line}${
                test.location.column === undefined
                  ? ""
                  : `:${test.location.column}`
              }`,
              "citation"
            );
          }
        }
        const stack = [...report.exceptions];
        while (stack.length > 0) {
          const exception = stack.shift();
          if (exception === undefined) continue;
          add(
            `exception:${exception.type}`,
            exception.type,
            "failure"
          );
          add(
            `exception-message:${exception.type}`,
            exception.message,
            "failure"
          );
          add(
            `exception-code:${exception.type}`,
            exception.code,
            "failure"
          );
          for (const frame of exception.frames) {
            add(
              `citation:${exception.type}`,
              `${frame.location.path}:${frame.location.line}${
                frame.location.column === undefined
                  ? ""
                  : `:${frame.location.column}`
              }`,
              "citation"
            );
          }
          stack.push(...exception.causes);
        }
        if (report.exitCode !== undefined) {
          add(
            "exit-code",
            String(report.exitCode),
            "evidence"
          );
        }
      }
    }
  }

  if (
    input.caseId === "cq06-missing" ||
    input.caseId === "cq06-observed"
  ) {
    const observation = input.artifacts.find((artifact) =>
      artifact.label.endsWith("response-observation.json")
    );
    if (observation !== undefined) {
      try {
        const parsed = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            observation.bytes
          )
        ) as Readonly<Record<string, unknown>>;
        for (const [key, value] of Object.entries(parsed)) {
          if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ) {
            add(`external:${key}`, String(value), "configuration");
          }
        }
      } catch {
        // The production pipeline still preserves the unreadable artifact.
      }
    }
  }

  const unique = new Map(
    values.map((item) => [
      `${item.kind}:${item.valueSha256}`,
      item
    ])
  );
  return [...unique.values()]
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.factId, "utf8"),
        Buffer.from(right.factId, "utf8")
      )
    )
    .slice(0, 96);
}

function deterministicAdvice(
  input: ManualBenchmarkInput
): Readonly<Record<string, unknown>> | undefined {
  const operation =
    input.caseId === "mf01"
      ? "MF-01-exact-operation"
      : input.caseId === "mf02"
        ? "MF-02-bounded-routine"
        : input.caseId === "mf03"
          ? "MF-03-reasoning-intensive"
          : undefined;
  return operation === undefined
    ? undefined
    : {
        operation,
        evidenceDecision: "ready",
        advisoryOnly: true,
        modelChangeRequiresNewSession: true
      };
}

function existingIdentity(
  outputRoot: string,
  relativePath: string
): BenchmarkFileIdentity {
  const bytes = readFileSync(join(outputRoot, relativePath));
  return {
    path: relativePath.replaceAll("\\", "/"),
    sha256: sha256Base64Url(bytes),
    byteLength: bytes.length
  };
}

export async function exportBenchmarkSuite(input: {
  readonly externalRoot: string;
  readonly output: string;
  readonly cases?: readonly string[];
  readonly now?: string;
}): Promise<Result<BenchmarkSuite>> {
  const cases = selectedCaseIds(input.cases);
  if (!cases.ok) return cases;
  let adapter: ExternalManualParityAdapter;
  try {
    adapter = new ExternalManualParityAdapter({
      root: input.externalRoot,
      maxFileBytes: 2 * 1024 * 1024,
      maxTotalBytes: 24 * 1024 * 1024,
      maxDurationMs: 60_000
    });
  } catch {
    return failure(
      "IO_ERROR",
      "External benchmark root is unavailable"
    );
  }
  const output = prepareOutputDirectory(input.output, {
    allowExisting: false
  });
  if (!output.ok) return output;
  let completed = false;
  try {
  const exported: BenchmarkExportCase[] = [];
  const sourceIdentities: {
    caseId: BenchmarkCaseId;
    inputDigest: string;
  }[] = [];

  for (const caseId of cases.value) {
    const benchmarkInput = adapter.loadBenchmarkInput(caseId);
    if (!benchmarkInput.ok) return benchmarkInput;
    sourceIdentities.push({
      caseId,
      inputDigest: benchmarkInput.value.inputDigest
    });
    const caseRoot = join(output.value, "cases", caseId);
    mkdirSync(caseRoot, { recursive: true });
    const storePath = join(caseRoot, "context.sqlite");
    const preparationStartedAt = performance.now();
    let contextTexts: { label: string; text: string }[];
    try {
      contextTexts = benchmarkInput.value.artifacts.map(
        (artifact) => ({
          label: artifact.label,
          text: new TextDecoder("utf-8", {
            fatal: true
          }).decode(artifact.bytes)
        })
      );
    } catch {
      return failure(
        "INVALID_UTF8",
        "External benchmark case is not valid UTF-8",
        { caseId }
      );
    }
    const prepared = await prepareContext({
      promptText: benchmarkInput.value.prompt,
      contextTexts,
      storePath
    });
    if (!prepared.ok) return prepared;
    const preparationLatencyMs = Math.max(
      0,
      performance.now() - preparationStartedAt
    );
    const store = new ContextStore(storePath);
    let originalBytes: Buffer;
    try {
      const verified = verifyStoredRun(
        store,
        prepared.value.package.runId
      );
      if (!verified.ok) return verified;
      const bytes = store.loadArtifactBytes(
        prepared.value.package.runId
      );
      if (!bytes.ok) return bytes;
      const snapshots = snapshotsFromManifest(
        verified.value.manifest,
        bytes.value
      );
      if (!snapshots.ok) return snapshots;
      originalBytes = renderContext(
        snapshots.value,
        new Map<string, readonly never[]>(),
        verified.value.manifest.evidence
      ).preparedBytes;
    } finally {
      store.close();
    }
    const caseAdvice = deterministicAdvice(benchmarkInput.value);
    const contractUnsigned = {
      caseId,
      contract: benchmarkInput.value.contract,
      kind: benchmarkInput.value.kind,
      prompt: benchmarkInput.value.prompt,
      requiredFacts: collectFacts(benchmarkInput.value),
      allowAbstention: benchmarkInput.value.allowAbstention,
      ...(caseAdvice === undefined
        ? {}
        : { deterministicAdvice: caseAdvice })
    };
    const contract: BenchmarkCaseContract = {
      ...contractUnsigned,
      digest: canonicalJsonDigest(contractUnsigned)
    };
    const original = writeNewBytes(
      output.value,
      `cases/${caseId}/original.bin`,
      originalBytes
    );
    const reduced = writeNewBytes(
      output.value,
      `cases/${caseId}/prepared.bin`,
      prepared.value.package.preparedBytes
    );
    const receipt = writeCanonicalNew(
      output.value,
      `cases/${caseId}/receipt.json`,
      prepared.value.receipt
    );
    const contractFile = writeCanonicalNew(
      output.value,
      `cases/${caseId}/contract.json`,
      contract
    );
    if (
      !original.ok ||
      !reduced.ok ||
      !receipt.ok ||
      !contractFile.ok
    ) {
      return failure(
        "IO_ERROR",
        "Unable to write benchmark case artifacts",
        { caseId }
      );
    }
    const advice = caseAdvice;
    const storeIdentity = existingIdentity(
      output.value,
      `cases/${caseId}/context.sqlite`
    );
    const exportedUnsigned = {
      caseId,
      contract: benchmarkInput.value.contract,
      kind: benchmarkInput.value.kind,
      runId: prepared.value.package.runId,
      storePath: `cases/${caseId}/context.sqlite`,
      store: storeIdentity,
      original: original.value,
      prepared: reduced.value,
      receipt: receipt.value,
      contractFile: contractFile.value,
      manifestSha256: prepared.value.package.manifestSha256,
      readiness: prepared.value.receipt.readiness,
      preparationLatencyMs,
      ...(advice === undefined
        ? {}
        : {
            deterministicAdviceDigest:
              canonicalJsonDigest(advice)
          })
    };
    exported.push({
      ...exportedUnsigned,
      digest: canonicalJsonDigest(exportedUnsigned)
    });
  }

  const createdAt = input.now ?? new Date().toISOString();
  const suiteUnsigned = {
    formatVersion: 1 as const,
    suiteId: randomUUID(),
    createdAt,
    sourceRootDigest: canonicalJsonDigest(sourceIdentities),
    selectedCases: cases.value,
    cases: exported,
    producerDigest: canonicalJsonDigest({
      producer: "benchmark-export",
      version: "1.0.0"
    })
  };
  const suite: BenchmarkSuite = {
    ...suiteUnsigned,
    digest: canonicalJsonDigest(suiteUnsigned)
  };
  const written = writeCanonicalNew(
    output.value,
    "benchmark-suite.json",
    suite
  );
  if (!written.ok) return written;
  completed = true;
  return success(suite);
  } catch (error) {
    return failure(
      "INTERNAL_ERROR",
      "Benchmark export failed",
      {
        errorDigest: canonicalJsonDigest(
          error instanceof Error ? error.message : String(error)
        )
      }
    );
  } finally {
    if (!completed) {
      rmSync(output.value, { recursive: true, force: true });
    }
  }
}
