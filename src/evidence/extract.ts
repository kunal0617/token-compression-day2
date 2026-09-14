import type {
  ArtifactClassification,
  ArtifactSnapshot,
  ByteRange,
  EvidenceKind,
  EvidenceSpan,
  RunOutcome
} from "../contracts/types.js";
import { sha256Base64Url, sha256Text } from "../core/hash.js";
import { splitRawLines, type LineRecord } from "../segment/segment.js";

interface EvidenceCandidate extends ByteRange {
  readonly kind: EvidenceKind;
  readonly reason: string;
  readonly mandatoryInline?: boolean;
}

function blockRange(
  lines: readonly LineRecord[],
  startOrdinal: number,
  predicate: (line: LineRecord, distance: number) => boolean,
  maxLines: number
): ByteRange {
  const first = lines[startOrdinal];
  if (first === undefined) return { startByte: 0, endByte: 0 };
  let endByte = first.endByte;
  for (
    let ordinal = startOrdinal + 1;
    ordinal < Math.min(lines.length, startOrdinal + maxLines);
    ordinal += 1
  ) {
    const line = lines[ordinal];
    if (line === undefined || !predicate(line, ordinal - startOrdinal)) break;
    endByte = line.endByte;
  }
  return { startByte: first.startByte, endByte };
}

function matchRange(line: LineRecord, match: RegExpExecArray): ByteRange {
  const startOffset = Buffer.byteLength(line.text.slice(0, match.index), "utf8");
  const matchedBytes = Buffer.byteLength(match[0], "utf8");
  return {
    startByte: line.startByte + startOffset,
    endByte: line.startByte + startOffset + matchedBytes
  };
}

function addMatchCandidates(
  line: LineRecord,
  pattern: RegExp,
  kind: EvidenceKind,
  reason: string,
  candidates: EvidenceCandidate[],
  mandatoryInline = true
): void {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  for (const match of line.text.matchAll(globalPattern)) {
    candidates.push({
      ...matchRange(line, match),
      kind,
      reason,
      mandatoryInline
    });
  }
}

export function extractEvidence(
  artifact: ArtifactSnapshot,
  classification: ArtifactClassification,
  outcome: RunOutcome
): EvidenceSpan[] {
  const lines = splitRawLines(artifact.bytes);
  const candidates: EvidenceCandidate[] = [];

  for (const line of lines) {
    const trimmed = line.text.trim();
    if (/^(?:\$|>|PS .+>|command:|run:)\s/i.test(trimmed)) {
      candidates.push({
        startByte: line.startByte,
        endByte: line.endByte,
        kind: "command",
        reason: "Command invocation"
      });
    }
    if (
      /\b(?:exit code|process exited with code)\s*[:=]?\s*-?\d+\b/i.test(
        line.text
      )
    ) {
      candidates.push({
        startByte: line.startByte,
        endByte: line.endByte,
        kind: "exit-code",
        reason: "Structured process exit code"
      });
    }
    if (/\b(?:FAIL(?:ED)?|not ok|✗|×)\b/i.test(line.text)) {
      candidates.push({
        startByte: line.startByte,
        endByte: line.endByte,
        kind: "failing-test",
        reason: "Failing test marker"
      });
    }
    if (/\b(?:AssertionError|expected|received|actual)\b/i.test(line.text)) {
      const range = blockRange(
        lines,
        line.ordinal,
        (next, distance) =>
          distance <= 8 &&
          (next.text.trim().length > 0 ||
            /^\s+(?:at|expected|actual|received|[+-])/i.test(next.text)),
        12
      );
      candidates.push({
        ...range,
        kind: "assertion-block",
        reason: "Complete assertion context"
      });
    }
    if (/^\s*(?:Expected|expected)\b/i.test(line.text)) {
      candidates.push({
        startByte: line.startByte,
        endByte: line.endByte,
        kind: "expected-value",
        reason: "Assertion expected value"
      });
    }
    if (/^\s*(?:Actual|actual|Received|received)\b/i.test(line.text)) {
      candidates.push({
        startByte: line.startByte,
        endByte: line.endByte,
        kind: "actual-value",
        reason: "Assertion actual value"
      });
    }
    if (
      /(?:^|\s)(?:Caused by:\s*)?(?:[A-Za-z_$][\w.$]*(?:Error|Exception|Failure)|Error|Exception|Failure):/.test(
        line.text
      )
    ) {
      const range = blockRange(
        lines,
        line.ordinal,
        (next, distance) =>
          distance <= 40 &&
          (/^\s+(?:at|\.{3}\s+\d+\s+more)/.test(next.text) ||
            /^\s*Caused by:/.test(next.text) ||
            /(?:Error|Exception|Failure):/.test(next.text) ||
            next.text.trim().length === 0),
        48
      );
      candidates.push({
        ...range,
        kind: "exception-chain",
        reason: "Complete exception chain"
      });
      candidates.push({
        startByte: line.startByte,
        endByte: line.endByte,
        kind: "exception",
        reason: "Exception message"
      });
    }
    if (/^\s*at\s+.+(?::\d+:\d+|\(.*:\d+:\d+\))/.test(line.text)) {
      candidates.push({
        startByte: line.startByte,
        endByte: line.endByte,
        kind: "stack-frame",
        reason: "Stack frame with source location"
      });
    }
    if (
      /(?:^|\s)(?:[A-Za-z]:)?[^:\r\n]+:\d+:\d+:\s*(?:error|warning)\b/i.test(
        line.text
      ) ||
      /\berror TS\d+\b/i.test(line.text)
    ) {
      candidates.push({
        startByte: line.startByte,
        endByte: line.endByte,
        kind: "compiler-diagnostic",
        reason: "Compiler diagnostic"
      });
    }

    addMatchCandidates(
      line,
      /(?:[A-Za-z]:)?(?:[\w.-]+[\\/])+[\w.-]+(?::\d+(?::\d+)?)?/,
      "path",
      "Path or source location",
      candidates
    );
    addMatchCandidates(
      line,
      /\b(?:[A-Za-z]:)?[^ \t\r\n:]+:\d+:\d+\b/,
      "source-location",
      "Source line and column",
      candidates
    );
    addMatchCandidates(
      line,
      /\b(?:correlation|request|trace)[-_ ]?id\s*[:=]\s*[\w.-]+\b/i,
      "correlation-id",
      "Correlation identifier",
      candidates
    );
    addMatchCandidates(
      line,
      /\b(?:v?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/,
      "version",
      "Version",
      candidates
    );
    addMatchCandidates(
      line,
      /\b\d{4}-\d{2}-\d{2}[T ][0-2]\d:[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/,
      "timestamp",
      "Timestamp",
      candidates,
      false
    );
    addMatchCandidates(
      line,
      /\b(?:[A-Z]{2,10}-\d+|[A-Fa-f0-9]{7,40}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/i,
      "identifier",
      "Diagnostic identifier",
      candidates,
      false
    );

    if (
      /\b(?:tests?|suites?)\s+(?:passed|failed|failing)\b/i.test(line.text) ||
      /\b(?:Build|Compilation)\s+(?:succeeded|failed)\b/i.test(line.text) ||
      /\b(?:summary|result|status)\b\s*[:=-]/i.test(line.text)
    ) {
      candidates.push({
        startByte: line.startByte,
        endByte: line.endByte,
        kind: "final-summary",
        reason: "Parser or textual final summary"
      });
    }

    if (
      outcome !== "green" &&
      ["test-log", "compiler-diagnostics", "stack-trace", "generic-log"].includes(
        classification.kind
      ) &&
      /\b(?:error|fail|fatal|panic|unknown)\b/i.test(line.text)
    ) {
      candidates.push({
        startByte: line.startByte,
        endByte: line.endByte,
        kind: "unknown-diagnostic",
        reason: "Conservative preservation of unsupported diagnostic content"
      });
    }
  }

  return candidates
    .sort(
      (left, right) =>
        left.startByte - right.startByte ||
        left.endByte - right.endByte ||
        left.kind.localeCompare(right.kind)
    )
    .map((candidate, index) => {
      const bytes = artifact.bytes.subarray(
        candidate.startByte,
        candidate.endByte
      );
      const occurrenceId = `occ:${sha256Text(
        `${artifact.artifactId}:${candidate.kind}:${candidate.startByte}:${candidate.endByte}:${index}`
      )}`;
      return {
        evidenceId: `evidence:${sha256Text(
          `${occurrenceId}:${sha256Base64Url(bytes)}`
        )}`,
        occurrenceId,
        artifactId: artifact.artifactId,
        kind: candidate.kind,
        startByte: candidate.startByte,
        endByte: candidate.endByte,
        sha256: sha256Base64Url(bytes),
        textPreview: bytes.toString("utf8").slice(0, 240),
        reasons: [candidate.reason],
        mandatoryInline: candidate.mandatoryInline ?? true,
        protectionReasons:
          candidate.mandatoryInline === false
            ? ["extracted-retrievable-metadata", candidate.reason]
            : ["day1-evidence", candidate.reason]
      };
    });
}
