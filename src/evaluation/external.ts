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
import { failure, success, type Result } from "../core/result.js";

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

  constructor(root: string) {
    this.root = realpathSync(resolve(root));
  }

  loadCases(manifestPath: string): Result<readonly EvaluationCase[]> {
    try {
      const path = realpathSync(resolve(this.root, manifestPath));
      if (!inside(this.root, path)) {
        return failure("INVALID_ARGUMENT", "Fixture manifest escapes external root");
      }
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        cases?: EvaluationCase[];
      };
      if (!Array.isArray(parsed.cases)) {
        return failure("INVALID_ARGUMENT", "External fixture manifest has no cases");
      }
      for (const testCase of parsed.cases) {
        for (const artifactPath of testCase.artifactPaths) {
          const artifact = realpathSync(resolve(this.root, artifactPath));
          if (!inside(this.root, artifact)) {
            return failure("INVALID_ARGUMENT", "Fixture artifact escapes external root");
          }
        }
      }
      return success(parsed.cases);
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

  constructor(input: {
    readonly adapterId: string;
    readonly externalRoot: string;
    readonly command: string;
    readonly args?: readonly string[];
  }) {
    this.metadata = producer(input.adapterId);
    this.#root = realpathSync(resolve(input.externalRoot));
    this.#command = input.command;
    this.#args = input.args ?? [];
  }

  async run(input: {
    plan: EvaluationTrialPlan;
    testCase: EvaluationCase;
  }): Promise<Result<EvaluationObservation>> {
    return new Promise((resolveResult) => {
      const child = spawn(this.#command, this.#args, {
        cwd: this.#root,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (error) =>
        resolveResult(
          failure("IO_ERROR", "External evaluation adapter failed", {
            cause: error.message
          })
        )
      );
      child.on("close", (code) => {
        if (code !== 0) {
          resolveResult(
            failure("IO_ERROR", "External evaluation adapter exited nonzero", {
              code,
              stderr: Buffer.concat(stderr).toString("utf8").slice(0, 2_000)
            })
          );
          return;
        }
        try {
          resolveResult(
            success(
              JSON.parse(Buffer.concat(stdout).toString("utf8")) as EvaluationObservation
            )
          );
        } catch (error) {
          resolveResult(
            failure("INTEGRITY_ERROR", "External adapter returned invalid JSON", {
              cause: error instanceof Error ? error.message : String(error)
            })
          );
        }
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
}

export function createRohitCqAdapter(input: {
  externalRoot: string;
  command: string;
  args?: readonly string[];
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
}) {
  return new ExternalJsonContractAdapter({
    adapterId: "external.luna.contracts",
    ...input
  });
}
