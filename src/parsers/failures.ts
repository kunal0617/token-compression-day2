import type {
  Detector,
  DetectorResult,
  ProducerMetadata
} from "../contracts/providers.js";
import type {
  FailureReport,
  ParsedCommand,
  ParsedEnvironmentFact,
  ParsedException,
  ParsedSourceLocation,
  ParsedStackFrame,
  ParsedTestFailure
} from "../contracts/failures.js";
import type { ArtifactSnapshot, ByteRange } from "../contracts/types.js";
import { analyzeCiLines } from "../ci/envelope.js";
import { canonicalJsonDigest } from "../core/canonical.js";
import { deterministicUuid } from "../core/hash.js";
import { success, type Result } from "../core/result.js";

export interface FailureParseRequest {
  readonly artifact: ArtifactSnapshot;
}

function producer(
  producerId: string,
  version: string,
  contract: unknown
): ProducerMetadata {
  return {
    producerId,
    kind: "detector",
    version,
    digest: canonicalJsonDigest({ producerId, version, contract })
  };
}

function locationFromText(text: string): ParsedSourceLocation | undefined {
  const match =
    /(?:\()?((?:[A-Za-z]:)?(?:[\w@+.-]+[\\/])*[\w@+.-]+\.(?:[cm]?[jt]sx?|mjs|cjs|py|rb|go|rs|java|cs|cpp|cc|c|h|hpp)):(\d+)(?::(\d+))?\)?/.exec(
      text
    );
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return {
    path: match[1],
    line: Number(match[2]),
    ...(match[3] === undefined ? {} : { column: Number(match[3]) })
  };
}

function stackFrame(
  text: string,
  range: ByteRange
): ParsedStackFrame | undefined {
  const location = locationFromText(text);
  if (location === undefined) return undefined;
  const functionName =
    /^\s*at\s+(.+?)\s+\(/.exec(text)?.[1] ??
    /^\s*at\s+([^\s]+)/.exec(text)?.[1];
  return {
    ...range,
    ...(functionName === undefined ? {} : { functionName }),
    location,
    text: text.trim()
  };
}

function commandFromText(
  text: string,
  range: ByteRange
): ParsedCommand | undefined {
  const command =
    /^(?:\$|>|PS .+>|command:|run:|\[command\])\s*(.+)$/i.exec(text.trim())?.[1];
  if (command === undefined) return undefined;
  return { ...range, command };
}

function environmentFromText(
  text: string,
  range: ByteRange
): ParsedEnvironmentFact | undefined {
  const version = /\b(Node(?:\.js)?|npm|pnpm|yarn|Vitest|Jest)\s+v?(\d+\.\d+(?:\.\d+)?)\b/i.exec(
    text
  );
  if (version?.[1] !== undefined && version[2] !== undefined) {
    return { ...range, key: version[1], value: version[2] };
  }
  const runner = /^\s*(Image|OS|Platform|Architecture):\s*(.+)$/i.exec(text);
  if (runner?.[1] !== undefined && runner[2] !== undefined) {
    return { ...range, key: runner[1], value: runner[2].trim() };
  }
  return undefined;
}

function reportId(
  artifactId: string,
  parser: FailureReport["parser"],
  producerDigest: string
): string {
  return deterministicUuid(`${artifactId}:${parser}:${producerDigest}`);
}

function finalExit(lines: readonly { content: string }[]): number | undefined {
  const exits = lines.flatMap((line) => [
    ...line.content.matchAll(
      /\b(?:exit code|process exited with code)\s*[:=]?\s*(-?\d+)\b/gi
    )
  ]);
  const value = exits.at(-1)?.[1];
  return value === undefined ? undefined : Number(value);
}

export class VitestJestFailureDetector
  implements Detector<FailureParseRequest, FailureReport>
{
  readonly metadata = producer(
    "builtin.cq02.vitest-jest-parser",
    "1.0.0",
    [
      "FAIL-file",
      "suite-test",
      "expected-received-actual",
      "assertion-diff",
      "summary",
      "command-exit"
    ]
  );

  detect(
    request: FailureParseRequest
  ): Result<DetectorResult<FailureReport>> {
    const analyses = analyzeCiLines(request.artifact);
    const recognized = analyses.some((line) =>
      /(?:^|\s)(?:Vitest|Jest|FAIL\s+\S+|Test Files|Test Suites|Tests:|Expected:|Received:)/i.test(
        line.content
      )
    );
    if (!recognized) {
      return success({ producer: this.metadata, findings: [], warnings: [] });
    }
    const tests: ParsedTestFailure[] = [];
    const commands: ParsedCommand[] = [];
    const environment: ParsedEnvironmentFact[] = [];
    let currentFile: string | undefined;
    let currentTest: ParsedTestFailure | undefined;
    for (const analysis of analyses) {
      const range = analysis.line;
      const text = analysis.content;
      const file =
        /^\s*FAIL\s+(.+?)(?:\s+>|\s+\[\s*.+\]\s*$|$)/.exec(text)?.[1];
      if (file !== undefined) currentFile = file.trim();
      const test =
        /^\s*(?:[×✗●]|not ok)\s+(.+?)\s*(?:\(\d+\s*m?s\))?\s*$/i.exec(
          text
        )?.[1] ??
        /^\s*FAIL\s+.+?\s*>\s*(.+)$/.exec(text)?.[1];
      if (test !== undefined) {
        const location = locationFromText(text);
        const previous = tests.at(-1);
        if (
          previous !== undefined &&
          previous.testName === test.trim() &&
          previous.file === currentFile
        ) {
          currentTest = {
            ...previous,
            endByte: range.endByte,
            ...(location === undefined ? {} : { location })
          };
          tests[tests.length - 1] = currentTest;
          continue;
        }
        const parsedTest: ParsedTestFailure = {
          startByte: range.startByte,
          endByte: range.endByte,
          testName: test.trim(),
          ...(currentFile === undefined ? {} : { file: currentFile }),
          ...(location === undefined ? {} : { location })
        };
        currentTest = parsedTest;
        tests.push(parsedTest);
      }
      const expected = /^\s*Expected:\s*([\s\S]+)$/i.exec(text)?.[1];
      const actual =
        /^\s*(?:Received|Actual):\s*([\s\S]+)$/i.exec(text)?.[1];
      if (currentTest !== undefined && expected !== undefined) {
        currentTest = { ...currentTest, expected };
        tests[tests.length - 1] = currentTest;
      }
      if (currentTest !== undefined && actual !== undefined) {
        currentTest = { ...currentTest, actual };
        tests[tests.length - 1] = currentTest;
      }
      const command = commandFromText(text, range);
      if (command !== undefined) commands.push(command);
      const environmentFact = environmentFromText(text, range);
      if (environmentFact !== undefined) environment.push(environmentFact);
    }
    const exitCode = finalExit(analyses);
    if (commands.length > 0 && exitCode !== undefined) {
      commands[commands.length - 1] = {
        ...(commands.at(-1) as ParsedCommand),
        exitCode
      };
    }
    const report: FailureReport = {
      reportId: reportId(
        request.artifact.artifactId,
        "vitest-jest",
        this.metadata.digest
      ),
      artifactId: request.artifact.artifactId,
      parser: "vitest-jest",
      recognized: true,
      tests,
      exceptions: [],
      commands,
      environment,
      ...(exitCode === undefined ? {} : { exitCode }),
      completeness:
        tests.length > 0 && exitCode !== undefined ? "complete" : "partial",
      completenessReasons: [
        tests.length > 0
          ? "At least one failing test was parsed"
          : "No failing test name was parsed",
        exitCode === undefined
          ? "No structured exit code was present"
          : "Structured exit code was present"
      ],
      fallbackRanges: [],
      producer: this.metadata
    };
    return success({
      producer: this.metadata,
      findings: [Object.freeze(report)],
      warnings: []
    });
  }
}

function parseExceptions(
  artifact: ArtifactSnapshot
): readonly ParsedException[] {
  interface MutableException {
    startByte: number;
    endByte: number;
    type: string;
    message: string;
    code?: string;
    frames: ParsedStackFrame[];
    causes: MutableException[];
  }
  const analyses = analyzeCiLines(artifact);
  const roots: MutableException[] = [];
  let current: MutableException | undefined;
  for (const analysis of analyses) {
    const match =
      /^\s*(?:Caused by:\s*)?([A-Za-z_$][\w.$]*(?:Error|Exception|Failure)|Error|Exception|Failure):\s*(.*)$/.exec(
        analysis.content
      );
    if (match?.[1] !== undefined) {
      const exception: MutableException = {
        startByte: analysis.line.startByte,
        endByte: analysis.line.endByte,
        type: match[1],
        message: match[2] ?? "",
        frames: [],
        causes: []
      };
      if (/^\s*Caused by:/.test(analysis.content) && current !== undefined) {
        current.causes.push(exception);
        current = exception;
      } else {
        current = exception;
        roots.push(exception);
      }
      continue;
    }
    const frame = stackFrame(analysis.content, analysis.line);
    if (frame !== undefined && current !== undefined) {
      current.endByte = analysis.line.endByte;
      current.frames.push(frame);
      continue;
    }
    const code = /\bcode:\s*['"]([^'"]+)['"]/.exec(analysis.content)?.[1];
    if (code !== undefined && current !== undefined) {
      current.code = code;
    }
  }
  const freeze = (exception: MutableException): ParsedException => ({
    startByte: exception.startByte,
    endByte: exception.endByte,
    type: exception.type,
    message: exception.message,
    ...(exception.code === undefined ? {} : { code: exception.code }),
    frames: exception.frames,
    causes: exception.causes.map(freeze)
  });
  return roots.map(freeze);
}

export class NodeV8FailureDetector
  implements Detector<FailureParseRequest, FailureReport>
{
  readonly metadata = producer(
    "builtin.cq02.node-v8-parser",
    "1.0.0",
    ["exception-type", "code", "causes", "frames", "command-exit", "environment"]
  );

  detect(
    request: FailureParseRequest
  ): Result<DetectorResult<FailureReport>> {
    const analyses = analyzeCiLines(request.artifact);
    const exceptions = parseExceptions(request.artifact);
    const recognized =
      exceptions.length > 0 ||
      analyses.some((line) => /\b(?:ERR_[A-Z_]+|node:internal)\b/.test(line.content));
    if (!recognized) {
      return success({ producer: this.metadata, findings: [], warnings: [] });
    }
    const commands = analyses
      .map((analysis) => commandFromText(analysis.content, analysis.line))
      .filter((command): command is ParsedCommand => command !== undefined);
    const environment = analyses
      .map((analysis) =>
        environmentFromText(analysis.content, analysis.line)
      )
      .filter(
        (fact): fact is ParsedEnvironmentFact => fact !== undefined
      );
    const exitCode = finalExit(analyses);
    if (commands.length > 0 && exitCode !== undefined) {
      commands[commands.length - 1] = {
        ...(commands.at(-1) as ParsedCommand),
        exitCode
      };
    }
    return success({
      producer: this.metadata,
      findings: [
        Object.freeze({
          reportId: reportId(
            request.artifact.artifactId,
            "node-v8",
            this.metadata.digest
          ),
          artifactId: request.artifact.artifactId,
          parser: "node-v8",
          recognized: true,
          tests: [],
          exceptions,
          commands,
          environment,
          ...(exitCode === undefined ? {} : { exitCode }),
          completeness:
            exceptions.length > 0 && exitCode !== undefined
              ? "complete"
              : "partial",
          completenessReasons: [
            `${exceptions.length} root exception(s) parsed`,
            exitCode === undefined
              ? "No structured exit code was present"
              : "Structured exit code was present"
          ],
          fallbackRanges: [],
          producer: this.metadata
        })
      ],
      warnings: []
    });
  }
}

export class ConservativeFailureFallbackDetector
  implements Detector<FailureParseRequest, FailureReport>
{
  readonly metadata = producer(
    "builtin.cq02.conservative-fallback",
    "1.0.0",
    ["error-lines", "failure-lines", "unknown-completeness", "preserve-raw-ranges"]
  );

  detect(
    request: FailureParseRequest
  ): Result<DetectorResult<FailureReport>> {
    const analyses = analyzeCiLines(request.artifact);
    const fallbackRanges = analyses
      .filter((line) =>
        /\b(?:error|failure|failed|fatal|panic|cancelled|timed_out)\b/i.test(
          line.content
        )
      )
      .map((line) => ({
        startByte: line.line.startByte,
        endByte: line.line.endByte
      }));
    return success({
      producer: this.metadata,
      findings: [
        Object.freeze({
          reportId: reportId(
            request.artifact.artifactId,
            "conservative-fallback",
            this.metadata.digest
          ),
          artifactId: request.artifact.artifactId,
          parser: "conservative-fallback",
          recognized: false,
          tests: [],
          exceptions: [],
          commands: [],
          environment: [],
          completeness: "unknown",
          completenessReasons: [
            "No typed failure parser recognized the artifact"
          ],
          fallbackRanges,
          producer: this.metadata
        })
      ],
      warnings: ["Typed failure parser did not recognize the artifact"]
    });
  }
}

export class TypedFailureParserRegistry {
  readonly #detectors = [
    vitestJestFailureDetector,
    nodeV8FailureDetector
  ] as const;
  readonly fallback = conservativeFailureFallbackDetector;

  producers(): readonly ProducerMetadata[] {
    return [...this.#detectors, this.fallback]
      .map((detector) => detector.metadata)
      .sort((left, right) => left.producerId.localeCompare(right.producerId));
  }

  parse(artifact: ArtifactSnapshot): Result<readonly FailureReport[]> {
    const reports: FailureReport[] = [];
    for (const detector of this.#detectors) {
      const result = detector.detect({ artifact });
      if (!result.ok) return result;
      reports.push(...result.value.findings);
    }
    if (reports.length > 0) return success(reports);
    const fallback = this.fallback.detect({ artifact });
    if (!fallback.ok) return fallback;
    return success(fallback.value.findings);
  }
}

export const vitestJestFailureDetector = new VitestJestFailureDetector();
export const nodeV8FailureDetector = new NodeV8FailureDetector();
export const conservativeFailureFallbackDetector =
  new ConservativeFailureFallbackDetector();
export const typedFailureParsers = new TypedFailureParserRegistry();
