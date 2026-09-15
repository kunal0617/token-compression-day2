import type {
  ArtifactClassification,
  ArtifactSnapshot,
  RunOutcome,
  TransformProposal,
  TransformReason
} from "../contracts/types.js";
import {
  analyzeCiLines,
  ciCriticalOrdinalsToKeep,
  isAllowedCiGroupBodyLine,
  isRecognizedCiArtifact,
  isCiRoutineWrapperContent,
  isRoutineCiDeprecation
} from "../ci/envelope.js";
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
  const proposals: TransformProposal[] = [];
  const middle = candidates.slice(1, -1);
  let start = 0;
  while (start < middle.length) {
    let end = start + 1;
    while (
      end < middle.length &&
      middle[end]?.ordinal === (middle[end - 1]?.ordinal ?? -2) + 1
    ) {
      end += 1;
    }
    const first = middle[start];
    const last = middle[end - 1];
    if (first !== undefined && last !== undefined) {
      proposals.push(
        proposal(
          artifact,
          { startByte: first.startByte, endByte: last.endByte },
          "scoped-boilerplate",
          45,
          end - start,
          {
            artifactKind: classification.kind,
            ruleSet: "v1"
          }
        )
      );
    }
    start = end;
  }
  return proposals;
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
  const stableText = normalizeVolatileTemplate(text);
  return (
    /^(?:\s*\[[^\]]+\]\s*)?(?:INFO|WARN|WARNING|DEBUG|PROGRESS)\b/i.test(text) &&
    (!isWarning || outcome === "green") &&
    !/\b(?:error|exception|fail|expected|actual|received|HTTP\s*\d+|test)\b/i.test(
      text
    ) &&
    !/(?:[A-Za-z]:)?[^ \t\r\n:]+:\d+:\d+/.test(stableText) &&
    !/\b(?:v?\d+\.\d+(?:\.\d+)?)\b/.test(stableText) &&
    !/(?:^|\s)(?:--[\w-]+|[\w.-]+=[^\s]+)/.test(stableText)
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
    const middle = occurrences.slice(1, -1);
    let start = 0;
    while (start < middle.length) {
      let end = start + 1;
      while (
        end < middle.length &&
        middle[end]?.ordinal === (middle[end - 1]?.ordinal ?? -2) + 1
      ) {
        end += 1;
      }
      const first = middle[start];
      const last = middle[end - 1];
      if (first !== undefined && last !== undefined) {
        proposals.push(
          proposal(
            artifact,
            { startByte: first.startByte, endByte: last.endByte },
            "volatile-template",
            40,
            end - start,
            {
              templateSha256: sha256Text(template),
              totalOccurrences: occurrences.length,
              approvedMasks: true
            }
          )
        );
      }
      start = end;
    }
  }
  return proposals;
}

function proposeCiWrapperGroups(
  artifact: ArtifactSnapshot
): TransformProposal[] {
  const analyses = analyzeCiLines(artifact);
  if (!isRecognizedCiArtifact(analyses)) return [];
  const stack: { start: number; title: string }[] = [];
  const retainedCritical = ciCriticalOrdinalsToKeep(analyses);
  const groups: { start: number; end: number; title: string }[] = [];
  for (const [index, analysis] of analyses.entries()) {
    if (analysis.directive === "group") {
      stack.push({ start: index, title: analysis.groupTitle ?? "unnamed" });
    } else if (analysis.directive === "endgroup") {
      const opened = stack.pop();
      if (opened !== undefined && index > opened.start + 1) {
        groups.push({ start: opened.start, end: index, title: opened.title });
      }
    }
  }

  const proposals: TransformProposal[] = [];
  const isSafeBodyLine = (
    analysis: (typeof analyses)[number] | undefined
  ): boolean =>
    analysis !== undefined &&
    analysis.content.trim().length > 0 &&
    !retainedCritical.has(analysis.line.ordinal);
  for (const group of groups) {
    const isAllowedSafeBodyLine = (
      analysis: (typeof analyses)[number] | undefined
    ): boolean =>
      isSafeBodyLine(analysis) &&
      analysis !== undefined &&
      isAllowedCiGroupBodyLine(analysis, group.title);
    const body = analyses.slice(group.start + 1, group.end);
    let start = 0;
    while (start < body.length) {
      while (
        start < body.length &&
        !isAllowedSafeBodyLine(body[start])
      ) {
        start += 1;
      }
      let end = start;
      while (
        end < body.length &&
        isAllowedSafeBodyLine(body[end])
      ) {
        end += 1;
      }
      const first = body[start];
      const last = body[end - 1];
      if (
        first !== undefined &&
        last !== undefined &&
        (end - start >= 2 ||
          last.line.endByte - first.line.startByte >= 256)
      ) {
        proposals.push(
          proposal(
            artifact,
            {
              startByte: first.line.startByte,
              endByte: last.line.endByte
            },
            "ci-wrapper",
            70,
            end - start,
            {
              ciRule: "group-safe-body",
              groupTitle: group.title.slice(0, 160)
            }
          )
        );
      }
      start = Math.max(end, start + 1);
    }
  }
  return proposals;
}

function proposeCiEnvelopeRepetition(
  artifact: ArtifactSnapshot
): TransformProposal[] {
  const analyses = analyzeCiLines(artifact);
  if (!isRecognizedCiArtifact(analyses)) return [];
  const retainedCritical = ciCriticalOrdinalsToKeep(analyses);
  const groups = new Map<string, typeof analyses[number][]>();
  for (const analysis of analyses) {
    if (
      !analysis.recognizedEnvelope ||
      analysis.content.trim().length === 0 ||
      retainedCritical.has(analysis.line.ordinal)
    ) {
      continue;
    }
    const existing = groups.get(analysis.stableSignature) ?? [];
    existing.push(analysis);
    groups.set(analysis.stableSignature, existing);
  }

  const proposals: TransformProposal[] = [];
  for (const [signature, occurrences] of groups) {
    if (occurrences.length < 3) continue;
    const middle = occurrences.slice(1, -1);
    let start = 0;
    while (start < middle.length) {
      let end = start + 1;
      while (
        end < middle.length &&
        middle[end]?.line.ordinal ===
          (middle[end - 1]?.line.ordinal ?? -2) + 1
      ) {
        end += 1;
      }
      const first = middle[start];
      const last = middle[end - 1];
      if (first !== undefined && last !== undefined) {
        proposals.push(
          proposal(
            artifact,
            {
              startByte: first.line.startByte,
              endByte: last.line.endByte
            },
            "ci-wrapper",
            isRoutineCiDeprecation(first.content) ? 65 : 55,
            end - start,
            {
              ciRule: "envelope-stable-repetition",
              signatureSha256: sha256Text(signature),
              totalOccurrences: occurrences.length
            }
          )
        );
      }
      start = end;
    }
  }
  return proposals;
}

function proposeCiRoutineWrapperRuns(
  artifact: ArtifactSnapshot
): TransformProposal[] {
  const analyses = analyzeCiLines(artifact);
  if (!isRecognizedCiArtifact(analyses)) return [];
  const retainedCritical = ciCriticalOrdinalsToKeep(analyses);
  const proposals: TransformProposal[] = [];
  let start = 0;
  while (start < analyses.length) {
    if (
      !isCiRoutineWrapperContent(analyses[start]?.content ?? "") ||
      retainedCritical.has(analyses[start]?.line.ordinal ?? -1)
    ) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (
      end < analyses.length &&
      isCiRoutineWrapperContent(analyses[end]?.content ?? "") &&
      !retainedCritical.has(analyses[end]?.line.ordinal ?? -1)
    ) {
      end += 1;
    }
    const first = analyses[start];
    const last = analyses[end - 1];
    if (
      first !== undefined &&
      last !== undefined &&
      (end - start >= 2 ||
        last.line.endByte - first.line.startByte >= 256)
    ) {
      proposals.push(
        proposal(
          artifact,
          {
            startByte: first.line.startByte,
            endByte: last.line.endByte
          },
          "ci-wrapper",
          60,
          end - start,
          { ciRule: "routine-wrapper-run" }
        )
      );
    }
    start = end;
  }
  return proposals;
}

export function proposeTransforms(
  artifact: ArtifactSnapshot,
  classification: ArtifactClassification,
  outcome: RunOutcome
): TransformProposal[] {
  if (
    artifact.role === "prompt" ||
    artifact.completeness !== "complete" ||
    classification.kind === "diff"
  ) {
    return [];
  }
  const lines = splitRawLines(artifact.bytes);
  return [
    ...proposeConsecutiveExact(artifact, lines),
    ...proposeRepeatedAnchors(artifact, lines),
    ...proposeNonConsecutiveExact(artifact, lines),
    ...proposeSuccessChatter(artifact, lines, outcome),
    ...proposeCiWrapperGroups(artifact),
    ...proposeCiEnvelopeRepetition(artifact),
    ...proposeCiRoutineWrapperRuns(artifact),
    ...proposeScopedBoilerplate(artifact, lines, classification),
    ...proposeVolatileTemplates(artifact, lines, outcome)
  ];
}
