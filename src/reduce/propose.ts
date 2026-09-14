import type {
  ArtifactClassification,
  ArtifactSnapshot,
  RunOutcome,
  TransformProposal,
  TransformReason
} from "../contracts/types.js";
import { sha256Base64Url, sha256Text } from "../core/hash.js";
import { splitRawLines, type LineRecord } from "../segment/segment.js";

function proposal(
  artifact: ArtifactSnapshot,
  range: { startByte: number; endByte: number },
  reason: TransformReason,
  priority: number,
  sourceCount: number,
  metadata: Readonly<Record<string, string | number | boolean>>
): TransformProposal {
  return {
    proposalId: `proposal:${sha256Text(
      `${artifact.artifactId}:${range.startByte}:${range.endByte}:${reason}`
    )}`,
    artifactId: artifact.artifactId,
    startByte: range.startByte,
    endByte: range.endByte,
    reason,
    priority,
    sourceCount,
    metadata
  };
}

function exactKey(line: LineRecord): string {
  return `${sha256Base64Url(line.bytes)}:${line.bytes.length}`;
}

function equalLines(left: LineRecord, right: LineRecord): boolean {
  return left.bytes.length === right.bytes.length && left.bytes.equals(right.bytes);
}

function proposeConsecutiveExact(
  artifact: ArtifactSnapshot,
  lines: readonly LineRecord[]
): TransformProposal[] {
  const proposals: TransformProposal[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start + 1;
    const first = lines[start];
    if (first === undefined) break;
    while (
      end < lines.length &&
      lines[end] !== undefined &&
      equalLines(first, lines[end] as LineRecord)
    ) {
      end += 1;
    }
    const count = end - start;
    if (count >= 3) {
      const omittedFirst = lines[start + 1];
      const omittedLast = lines[end - 2];
      if (omittedFirst !== undefined && omittedLast !== undefined) {
        proposals.push(
          proposal(
            artifact,
            {
              startByte: omittedFirst.startByte,
              endByte: omittedLast.endByte
            },
            "exact-consecutive-repetition",
            100,
            count - 2,
            {
              repeatedLineSha256: exactKey(first),
              totalOccurrences: count,
              keptOccurrences: 2
            }
          )
        );
      }
    }
    start = end;
  }
  return proposals;
}

function proposeNonConsecutiveExact(
  artifact: ArtifactSnapshot,
  lines: readonly LineRecord[]
): TransformProposal[] {
  const groups = new Map<string, LineRecord[]>();
  for (const line of lines) {
    const key = exactKey(line);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [line]);
    } else if (equalLines(existing[0] as LineRecord, line)) {
      existing.push(line);
    } else {
      groups.set(`${key}:collision:${line.ordinal}`, [line]);
    }
  }

  const proposals: TransformProposal[] = [];
  for (const occurrences of groups.values()) {
    if (occurrences.length < 4) continue;
    for (const line of occurrences.slice(1, -1)) {
      proposals.push(
        proposal(
          artifact,
          line,
          "exact-nonconsecutive-repetition",
          80,
          1,
          {
            repeatedLineSha256: exactKey(line),
            totalOccurrences: occurrences.length,
            keptOccurrences: 2
          }
        )
      );
    }
  }
  return proposals;
}

function proposeRepeatedAnchors(
  artifact: ArtifactSnapshot,
  lines: readonly LineRecord[]
): TransformProposal[] {
  const windowSize = 3;
  const groups = new Map<string, { first: LineRecord; last: LineRecord }[]>();
  for (let index = 0; index <= lines.length - windowSize; index += 1) {
    const window = lines.slice(index, index + windowSize);
    const first = window[0];
    const last = window.at(-1);
    if (first === undefined || last === undefined) continue;
    const bytes = artifact.bytes.subarray(first.startByte, last.endByte);
    const key = `${sha256Base64Url(bytes)}:${bytes.length}`;
    const existing = groups.get(key) ?? [];
    const overlapsExisting = existing.some(
      (entry) =>
        first.startByte < entry.last.endByte &&
        entry.first.startByte < last.endByte
    );
    if (!overlapsExisting) {
      existing.push({ first, last });
      groups.set(key, existing);
    }
  }

  const proposals: TransformProposal[] = [];
  for (const [key, occurrences] of groups) {
    if (occurrences.length < 3) continue;
    const exemplar = occurrences[0];
    if (exemplar === undefined) continue;
    const exemplarBytes = artifact.bytes.subarray(
      exemplar.first.startByte,
      exemplar.last.endByte
    );
    const verified = occurrences.filter((entry) =>
      artifact.bytes
        .subarray(entry.first.startByte, entry.last.endByte)
        .equals(exemplarBytes)
    );
    for (const entry of verified.slice(1, -1)) {
      proposals.push(
        proposal(
          artifact,
          {
            startByte: entry.first.startByte,
            endByte: entry.last.endByte
          },
          "exact-nonconsecutive-repetition",
          85,
          windowSize,
          {
            anchorSha256: key,
            totalOccurrences: verified.length,
            windowLines: windowSize
          }
        )
      );
    }
  }
  return proposals;
}

function isGreenChatter(text: string): boolean {
  return (
    /\b(?:PASS|passed|success|succeeded|cache hit|downloaded|restored)\b/i.test(
      text
    ) ||
    /\b(?:\d{1,3}%|progress|loading|building)\b/i.test(text)
  );
}

function proposeSuccessChatter(
  artifact: ArtifactSnapshot,
  lines: readonly LineRecord[],
  outcome: RunOutcome
): TransformProposal[] {
  if (outcome !== "green") return [];
  const proposals: TransformProposal[] = [];
  let start = 0;
  while (start < lines.length) {
    if (!isGreenChatter(lines[start]?.text ?? "")) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < lines.length && isGreenChatter(lines[end]?.text ?? "")) {
      end += 1;
    }
    if (end - start >= 4) {
      const firstOmitted = lines[start + 1];
      const lastOmitted = lines[end - 2];
      if (firstOmitted !== undefined && lastOmitted !== undefined) {
        proposals.push(
          proposal(
            artifact,
            {
              startByte: firstOmitted.startByte,
              endByte: lastOmitted.endByte
            },
            "success-chatter",
            60,
            end - start - 2,
            {
              outcome,
              authoritative: true
            }
          )
        );
      }
    }
    start = end;
  }
  return proposals;
}

const scopedBoilerplatePatterns: readonly RegExp[] = [
  /^\s*(?:npm|pnpm|yarn)\s+(?:notice|warn deprecated)\b/i,
  /^\s*(?:Determining projects to restore|Restored .+ in \d+)/i,
  /^\s*(?:Downloading|Downloaded)\s+https?:\/\//i,
  /^\s*(?:Telemetry|Copyright|All rights reserved)\b/i
];

function proposeScopedBoilerplate(
  artifact: ArtifactSnapshot,
  lines: readonly LineRecord[],
  classification: ArtifactClassification
): TransformProposal[] {
  if (!["generic-log", "test-log", "compiler-diagnostics"].includes(classification.kind)) {
    return [];
  }
  const candidates = lines.filter((line) =>
    scopedBoilerplatePatterns.some((pattern) => pattern.test(line.text))
  );
  if (candidates.length < 3) return [];
  return candidates.slice(1, -1).map((line) =>
    proposal(artifact, line, "scoped-boilerplate", 45, 1, {
      artifactKind: classification.kind,
      ruleSet: "v1"
    })
  );
}

function normalizeVolatileTemplate(text: string): string {
  return text
    .replace(
      /\b\d{4}-\d{2}-\d{2}[T ][0-2]\d:[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
      "<timestamp>"
    )
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds|m|min|minutes)\b/gi, "<duration>")
    .replace(/\bworker[-_ ]?\d+\b/gi, "<worker>")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      "<uuid>"
    )
    .replace(/\b\d{1,3}%\b/g, "<progress>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<address>");
}

function safeTemplateCandidate(text: string, outcome: RunOutcome): boolean {
  const isWarning = /^(?:\s*\[[^\]]+\]\s*)?(?:WARN|WARNING)\b/i.test(text);
  return (
    /^(?:\s*\[[^\]]+\]\s*)?(?:INFO|WARN|WARNING|DEBUG|PROGRESS)\b/i.test(text) &&
    (!isWarning || outcome === "green") &&
    !/\b(?:error|exception|fail|expected|actual|received|HTTP\s*\d+|test)\b/i.test(
      text
    ) &&
    !/(?:[A-Za-z]:)?[^ \t\r\n:]+:\d+:\d+/.test(text) &&
    !/\b(?:v?\d+\.\d+(?:\.\d+)?)\b/.test(text) &&
    !/[=-](?:--)?[\w-]+/.test(text)
  );
}

function proposeVolatileTemplates(
  artifact: ArtifactSnapshot,
  lines: readonly LineRecord[],
  outcome: RunOutcome
): TransformProposal[] {
  const groups = new Map<string, LineRecord[]>();
  for (const line of lines) {
    if (!safeTemplateCandidate(line.text, outcome)) continue;
    const normalized = normalizeVolatileTemplate(line.text);
    if (normalized === line.text) continue;
    const existing = groups.get(normalized) ?? [];
    existing.push(line);
    groups.set(normalized, existing);
  }

  const proposals: TransformProposal[] = [];
  for (const [template, occurrences] of groups) {
    if (occurrences.length < 4) continue;
    for (const line of occurrences.slice(1, -1)) {
      proposals.push(
        proposal(artifact, line, "volatile-template", 40, 1, {
          templateSha256: sha256Text(template),
          totalOccurrences: occurrences.length,
          approvedMasks: true
        })
      );
    }
  }
  return proposals;
}

export function proposeTransforms(
  artifact: ArtifactSnapshot,
  classification: ArtifactClassification,
  outcome: RunOutcome
): TransformProposal[] {
  if (artifact.role === "prompt" || artifact.completeness !== "complete") return [];
  const lines = splitRawLines(artifact.bytes);
  return [
    ...proposeConsecutiveExact(artifact, lines),
    ...proposeRepeatedAnchors(artifact, lines),
    ...proposeNonConsecutiveExact(artifact, lines),
    ...proposeSuccessChatter(artifact, lines, outcome),
    ...proposeScopedBoilerplate(artifact, lines, classification),
    ...proposeVolatileTemplates(artifact, lines, outcome)
  ];
}
