import type {
  ArtifactClassification,
  ArtifactSnapshot,
  ByteRange,
  EvidenceKind,
  EvidenceSpan,
  RunOutcome
} from "../contracts/types.js";
import {
  analyzeCiLines,
  ciCriticalOrdinalsToKeep,
  isCiActualDiagnosticContent,
  isCiCriticalLine,
  isRecognizedCiArtifact,
  isRoutineCiDeprecation
} from "../ci/envelope.js";
import { sha256Base64Url, sha256Text } from "../core/hash.js";
import {
  segmentArtifact,
  splitRawLines,
  type LineRecord
} from "../segment/segment.js";

interface EvidenceCandidate extends ByteRange {
  readonly kind: EvidenceKind;
  readonly reason: string;
  readonly mandatoryInline?: boolean;
}

function isFailingTestText(text: string): boolean {
  return (
    /^(?:FAIL(?:ED)?\b|not ok\b|[✗×]\s)/i.test(text.trim()) ||
    /\b(?:tests?|suites?)\s+(?:failed|failing)\b/i.test(text)
  );
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
  mandatoryInline = true,
  accept: (match: RegExpExecArray) => boolean = () => true
): void {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);
  for (const match of line.text.matchAll(globalPattern)) {
    if (!accept(match)) continue;
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
  const analyses = analyzeCiLines(artifact);
  const lines = analyses.map((analysis) => analysis.line);
  const ciArtifact = isRecognizedCiArtifact(analyses);
  const retainedCiCritical = ciCriticalOrdinalsToKeep(analyses);
  const segments = segmentArtifact(artifact);
  const candidates: EvidenceCandidate[] = [];

  for (const analysis of analyses) {
    const { line } = analysis;
    const text = analysis.content;
    const trimmed = text.trim();
    const segmentKind = segments[line.ordinal]?.kind ?? "text";
    const diagnosticContext =
      (ciArtifact
        ? ["command", "diff", "stack"].includes(segmentKind) ||
          isCiActualDiagnosticContent(text)
        : ["command", "diagnostic", "diff", "stack", "summary"].includes(
            segmentKind
          )          ) ||
          isFailingTestText(text) ||
          /\b(?:AssertionError|expected|received|actual)\b/i.test(text);
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
        text
      )
    ) {
      candidates.push({
        startByte: line.startByte,
        endByte: line.endByte,
        kind: "exit-code",
        reason: "Structured process exit code"
      });
    }
    if (
      isFailingTestText(text) &&
      (!ciArtifact || !analysis.hadAnsi || isCiActualDiagnosticContent(text))
    ) {
      candidates.push({
        startByte: line.startByte,
        endByte: line.endByte,
        kind: "failing-test",
        reason: "Failing test marker"
      });
    }
    if (/\b(?:AssertionError|expected|received|actual)\b/i.test(text)) {
      const range = blockRange(
        lines,
        line.ordinal,
        (next, distance) =>
          distance <= 8 &&
          ((analyses[next.ordinal]?.content ?? next.text).trim().length > 0 ||
            /^\s+(?:at|expected|actual|received|[+-])/i.test(
              analyses[next.ordinal]?.content ?? next.text
            )),
        12
      );
      candidates.push({
        ...range,
        kind: "assertion-block",
        reason: "Complete assertion context"
      });
    }
    if (/^\s*(?:Expected|expected)\b/i.test(text)) {
      candidates.push({
        startByte: line.startByte,
        endByte: line.endByte,
        kind: "expected-value",
        reason: "Assertion expected value"
      });
    }
    if (/^\s*(?:Actual|actual|Received|received)\b/i.test(text)) {
      candidates.push({
        startByte: line.startByte,
        endByte: line.endByte,
        kind: "actual-value",
        reason: "Assertion actual value"
      });
    }
    if (
      /(?:^|\s)(?:Caused by:\s*)?(?:[A-Za-z_$][\w.$]*(?:Error|Exception|Failure)|Error|Exception|Failure):/.test(
        text
      )
    ) {
      const range = blockRange(
        lines,
        line.ordinal,
        (next, distance) =>
          distance <= 40 &&
          (/^\s+(?:at|\.{3}\s+\d+\s+more)/.test(
            analyses[next.ordinal]?.content ?? next.text
          ) ||
            /^\s*Caused by:/.test(
              analyses[next.ordinal]?.content ?? next.text
            ) ||
            /(?:Error|Exception|Failure):/.test(
              analyses[next.ordinal]?.content ?? next.text
            ) ||
            (analyses[next.ordinal]?.content ?? next.text).trim().length === 0),
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
    if (/^\s*at\s+.+(?::\d+:\d+|\(.*:\d+:\d+\))/.test(text)) {
      candidates.push({
        startByte: line.startByte,
        endByte: line.endByte,
        kind: "stack-frame",
        reason: "Stack frame with source location"
      });
    }
    if (
      /(?:^|\s)(?:[A-Za-z]:)?[^:\r\n]+:\d+:\d+:\s*(?:error|warning)\b/i.test(
        text
      ) ||
      /\berror TS\d+\b/i.test(text)
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
      candidates,
      diagnosticContext
    );
    addMatchCandidates(
      line,
      /\b(?:[A-Za-z]:)?(?:[\w@+.-]+[\\/])*[\w@+.-]+\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|cs|cpp|cc|c|h|hpp|swift|kt|kts|scala|sh|ps1|ya?ml|json|toml|xml|sql|md):\d+(?::\d+)?\b/i,
      "source-location",
      "Source line and column",
      candidates,
      diagnosticContext,
      (match) => {
        const prefix = line.text.slice(0, match.index);
        const tokenPrefix = prefix.slice(
          Math.max(
            prefix.lastIndexOf(" "),
            prefix.lastIndexOf("\t"),
            prefix.lastIndexOf("\"")
          ) + 1
        );
        return !tokenPrefix.includes("://");
      }
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
      candidates,
      false
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
      /\b(?:tests?|suites?)\s+(?:passed|failed|failing)\b/i.test(text) ||
      /\b(?:Build|Compilation)\s+(?:succeeded|failed)\b/i.test(text) ||
      /^\s*(?:summary|result|status)\s*[:=]/i.test(text)
    ) {
      candidates.push({
        startByte: line.startByte,
        endByte: line.endByte,
        kind: "final-summary",
        reason: "Parser or textual final summary"
      });
    }

    if (ciArtifact && isCiCriticalLine(analysis)) {
      candidates.push({
        startByte: line.startByte,
        endByte: line.endByte,
        kind: "ci-critical",
        reason: "CI job, outcome, run, branch, image, artifact, or metrics evidence",
        mandatoryInline: retainedCiCritical.has(line.ordinal)
      });
    } else if (ciArtifact && isRoutineCiDeprecation(text)) {
      candidates.push({
        startByte: line.startByte,
        endByte: line.endByte,
        kind: "unknown-diagnostic",
        reason: "Retrievable repeated CI deprecation metadata",
        mandatoryInline: false
      });
    }

    if (
      outcome !== "green" &&
      ["test-log", "compiler-diagnostics", "stack-trace", "generic-log"].includes(
        classification.kind
      ) &&
      (ciArtifact
        ? isCiActualDiagnosticContent(text)
        : /\b(?:error|fail|fatal|panic|unknown)\b/i.test(text))
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
