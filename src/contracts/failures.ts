import type { ByteRange } from "./types.js";
import type { ProducerMetadata } from "./providers.js";

export interface ParsedSourceLocation {
  readonly path: string;
  readonly line: number;
  readonly column?: number;
}

export interface ParsedStackFrame extends ByteRange {
  readonly functionName?: string;
  readonly location: ParsedSourceLocation;
  readonly text: string;
}

export interface ParsedException extends ByteRange {
  readonly type: string;
  readonly message: string;
  readonly code?: string;
  readonly frames: readonly ParsedStackFrame[];
  readonly causes: readonly ParsedException[];
}

export interface ParsedTestFailure extends ByteRange {
  readonly suite?: string;
  readonly testName: string;
  readonly file?: string;
  readonly expected?: string;
  readonly actual?: string;
  readonly diff?: string;
  readonly location?: ParsedSourceLocation;
}

export interface ParsedCommand extends ByteRange {
  readonly command: string;
  readonly shell?: string;
  readonly exitCode?: number;
}

export interface ParsedEnvironmentFact extends ByteRange {
  readonly key: string;
  readonly value: string;
}

export interface FailureReport {
  readonly reportId: string;
  readonly artifactId: string;
  readonly parser: "vitest-jest" | "node-v8" | "conservative-fallback";
  readonly recognized: boolean;
  readonly tests: readonly ParsedTestFailure[];
  readonly exceptions: readonly ParsedException[];
  readonly commands: readonly ParsedCommand[];
  readonly environment: readonly ParsedEnvironmentFact[];
  readonly exitCode?: number;
  readonly completeness: "complete" | "partial" | "unknown";
  readonly completenessReasons: readonly string[];
  readonly fallbackRanges: readonly ByteRange[];
  readonly producer: ProducerMetadata;
}

