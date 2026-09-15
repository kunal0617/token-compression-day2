import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, relative } from "node:path";
import { spawn } from "node:child_process";

import type {
  EvaluationCase,
  EvaluationObservation,
  EvaluationTrialPlan
} from "../contracts/evaluation.js";
import type {
  EvaluationAdapter,
  ProducerMetadata
} from "../contracts/providers.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import { sha256Base64Url } from "../core/hash.js";
import { failure, success, type Result } from "../core/result.js";
import {
  parseEvaluationObservation,
  validateEvaluationCases
} from "./harness.js";

function producer(producerId: string): ProducerMetadata {
  const version = "1.0.0";
  return {
    producerId,
    kind: "evaluation",
    version,
    digest: canonicalJsonDigest({
      producerId,
      version,
      contract: ["external-root-only", "json-stdin-stdout", "no-vendoring"]
    })
  };
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child.length === 0 ||
    (!child.startsWith("..") && !isAbsolute(child))
  );
}

export class ExternalLocalFixtureAdapter {
  readonly root: string;
  readonly #maxArtifactBytes: number;
  readonly #maxTotalBytes: number;

  constructor(
    root: string,
    limits: {
      readonly maxArtifactBytes?: number;
      readonly maxTotalBytes?: number;
    } = {}
  ) {
    this.root = realpathSync(resolve(root));
    this.#maxArtifactBytes = limits.maxArtifactBytes ?? 8 * 1024 * 1024;
    this.#maxTotalBytes = limits.maxTotalBytes ?? 32 * 1024 * 1024;
  }

  loadCases(manifestPath: string): Result<readonly EvaluationCase[]> {
    try {
      const path = realpathSync(resolve(this.root, manifestPath));
      if (!inside(this.root, path)) {
        return failure("INVALID_ARGUMENT", "Fixture manifest escapes external root");
      }
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        cases?: unknown;
      };
      const cases = validateEvaluationCases(parsed.cases, true);
      if (!cases.ok) {
        return failure("INVALID_ARGUMENT", "External fixture manifest has no cases");
      }
      const enriched: EvaluationCase[] = [];
      let totalBytes = 0;
      for (const testCase of cases.value) {
        const artifactIdentities = [];
        for (const artifactPath of testCase.artifactPaths) {
          const artifact = realpathSync(resolve(this.root, artifactPath));
          if (!inside(this.root, artifact)) {
            return failure("INVALID_ARGUMENT", "Fixture artifact escapes external root");
          }
          const bytes = readFileSync(artifact);
          totalBytes += bytes.length;
          if (
            bytes.length > this.#maxArtifactBytes ||
            totalBytes > this.#maxTotalBytes
          ) {
            return failure(
              "LIMIT_EXCEEDED",
              "External fixture artifacts exceed configured limits"
            );
          }
          artifactIdentities.push({
            path: artifactPath,
            sha256: sha256Base64Url(bytes),
            byteLength: bytes.length
          });
        }
        enriched.push({ ...testCase, artifactIdentities });
      }
      return success(enriched);
    } catch (error) {
      return failure("IO_ERROR", "Unable to load external fixture manifest", {
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

export class ExternalJsonContractAdapter
  implements
    EvaluationAdapter<
      { plan: EvaluationTrialPlan; testCase: EvaluationCase },
      EvaluationObservation
    >
{
  readonly metadata: ProducerMetadata;
  readonly #root: string;
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #dangerousOptIn: boolean;
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly executableDigest: string;
  readonly protocolDigest: string;

  constructor(input: {
    readonly adapterId: string;
    readonly externalRoot: string;
    readonly command: string;
    readonly args?: readonly string[];
    readonly dangerousOptIn?: boolean;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  }) {
    this.metadata = producer(input.adapterId);
    this.#root = realpathSync(resolve(input.externalRoot));
    this.#command = realpathSync(resolve(input.command));
    this.#args = input.args ?? [];
    this.#dangerousOptIn = input.dangerousOptIn === true;
    this.#timeoutMs = input.timeoutMs ?? 60_000;
    this.#maxOutputBytes = input.maxOutputBytes ?? 1024 * 1024;
    this.executableDigest = sha256Base64Url(readFileSync(this.#command));
    this.protocolDigest = canonicalJsonDigest({
      protocol: "ctxo-evaluation-json-stdin-stdout",
      version: 1,
      adapterId: input.adapterId
    });
  }

  async run(input: {
    plan: EvaluationTrialPlan;
    testCase: EvaluationCase;
  }): Promise<Result<EvaluationObservation>> {
    if (!this.#dangerousOptIn) {
      return failure(
        "INVALID_ARGUMENT",
        "Arbitrary external command adapters are disabled by default; explicit dangerousOptIn is required"
      );
    }
    if (
      input.plan.settings.adapterId !== this.metadata.producerId ||
      input.plan.settings.executableDigest !== this.executableDigest ||
      input.plan.settings.protocolDigest !== this.protocolDigest
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "Evaluation plan is not bound to this adapter executable"
      );
    }
    const artifacts = this.verifyArtifacts(input.testCase);
    if (!artifacts.ok) return artifacts;
    if (
      sha256Base64Url(readFileSync(this.#command)) !==
      this.executableDigest
    ) {
      return failure(
        "INTEGRITY_ERROR",
        "External evaluation executable changed after approval"
      );
    }
    return new Promise((resolveResult) => {
      let settled = false;
      const child = spawn(this.#command, this.#args, {
        cwd: this.#root,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: Object.fromEntries(
          ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME"]
            .filter((key) => process.env[key] !== undefined)
            .map((key) => [key, process.env[key] as string])
        )
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      const finish = (result: Result<EvaluationObservation>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult(result);
      };
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > this.#maxOutputBytes) {
          child.kill();
          finish(
            failure(
              "LIMIT_EXCEEDED",
              "External evaluation output exceeded the configured limit"
            )
          );
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      const timer = setTimeout(() => {
        child.kill();
        finish(
          failure("IO_ERROR", "External evaluation adapter timed out", {
            timeoutMs: this.#timeoutMs
          })
        );
      }, this.#timeoutMs);
      child.on("error", (error) =>
        finish(
          failure("IO_ERROR", "External evaluation adapter failed", {
            errorDigest: canonicalJsonDigest(error.message)
          })
        )
      );
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finish(
            failure("IO_ERROR", "External evaluation adapter exited nonzero", {
              code,
              stderrDigest: sha256Base64Url(Buffer.concat(stderr))
            })
          );
          return;
        }
        try {
          const parsedJson: unknown = JSON.parse(
            Buffer.concat(stdout).toString("utf8")
          );
          const parsed = parseEvaluationObservation(parsedJson);
          if (!parsed.ok) {
            finish(parsed);
            return;
          }
          finish(
            success({
              ...parsed.value,
              execution: {
                ...parsed.value.execution,
                adapterProducerId: this.metadata.producerId,
                executableDigest: this.executableDigest,
                protocolDigest: this.protocolDigest
              }
            })
          );
        } catch (error) {
          finish(
            failure("INTEGRITY_ERROR", "External adapter returned invalid JSON", {
              errorDigest: canonicalJsonDigest(
                error instanceof Error ? error.message : String(error)
              )
            })
          );
        }
      });
      child.stdin.end(JSON.stringify(input));
    });
  }

  verifyArtifacts(testCase: EvaluationCase): Result<void> {
    try {
      if (
        testCase.artifactIdentities.length !==
        testCase.artifactPaths.length
      ) {
        return failure(
          "INTEGRITY_ERROR",
          "Evaluation artifact identities are incomplete"
        );
      }
      for (const identity of testCase.artifactIdentities) {
        const artifact = realpathSync(
          resolve(this.#root, identity.path)
        );
        if (!inside(this.#root, artifact)) {
          return failure(
            "INTEGRITY_ERROR",
            "Evaluation artifact escapes external root"
          );
        }
        const bytes = readFileSync(artifact);
        if (
          bytes.length !== identity.byteLength ||
          sha256Base64Url(bytes) !== identity.sha256
        ) {
          return failure(
            "INTEGRITY_ERROR",
            "Evaluation artifact changed after manifest creation"
          );
        }
      }
      return success(undefined);
    } catch (error) {
      return failure(
        "IO_ERROR",
        "Unable to verify evaluation artifacts",
        {
          errorDigest: canonicalJsonDigest(
            error instanceof Error ? error.message : String(error)
          )
        }
      );
    }
  }
}

export function createRohitCqAdapter(input: {
  externalRoot: string;
  command: string;
  args?: readonly string[];
  dangerousOptIn?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}) {
  return new ExternalJsonContractAdapter({
    adapterId: "external.rohit.cq01-07",
    ...input
  });
}

export function createRohitMfAdapter(input: {
  externalRoot: string;
  command: string;
  args?: readonly string[];
  dangerousOptIn?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}) {
  return new ExternalJsonContractAdapter({
    adapterId: "external.rohit.mf01-03",
    ...input
  });
}

export function createLunaAdapter(input: {
  externalRoot: string;
  command: string;
  args?: readonly string[];
  dangerousOptIn?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}) {
  return new ExternalJsonContractAdapter({
    adapterId: "external.luna.contracts",
    ...input
  });
}
