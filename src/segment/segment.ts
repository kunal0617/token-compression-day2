import type {
  ArtifactSnapshot,
  ByteRange,
  Segment,
  SegmentKind
} from "../contracts/types.js";
import { sha256Base64Url, sha256Text } from "../core/hash.js";

export interface LineRecord extends ByteRange {
  readonly ordinal: number;
  readonly bytes: Buffer;
  readonly text: string;
}

export function splitRawLines(bytes: Buffer): LineRecord[] {
  if (bytes.length === 0) return [];
  const lines: LineRecord[] = [];
  let start = 0;

  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a && bytes[index] !== 0x0d) continue;
    let end = index + 1;
    if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) {
      end += 1;
      index += 1;
    }
    const lineBytes = bytes.subarray(start, end);
    lines.push({
      ordinal: lines.length,
      startByte: start,
      endByte: end,
      bytes: lineBytes,
      text: lineBytes.toString("utf8")
    });
    start = end;
  }

  if (start < bytes.length) {
    const lineBytes = bytes.subarray(start);
    lines.push({
      ordinal: lines.length,
      startByte: start,
      endByte: bytes.length,
      bytes: lineBytes,
      text: lineBytes.toString("utf8")
    });
  }
  return lines;
}

function classifyLine(text: string): SegmentKind {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "blank";
  if (/^(?:\$|>|PS .+>|command:|run:)\s/i.test(trimmed)) return "command";
  if (/^(?:diff --git|@@ |--- [ab]\/|\+\+\+ [ab]\/|[+-][^+-])/i.test(trimmed)) {
    return "diff";
  }
  if (
    /^(?:at\s+|Caused by:)/i.test(trimmed) ||
    /\b(?:Error|Exception|Failure):/.test(trimmed)
  ) {
    return "stack";
  }
  if (
    /\b(?:error TS\d+|error|failed|failure|expected|actual|received)\b/i.test(
      trimmed
    )
  ) {
    return "diagnostic";
  }
  if (
    /\b(?:tests?|suites?)\s+(?:passed|failed)\b/i.test(trimmed) ||
    /\b(?:summary|result|exit code)\b/i.test(trimmed)
  ) {
    return "summary";
  }
  if (
    /\b(?:PASS|passed|success|succeeded|cache hit|downloaded|restored)\b/i.test(
      trimmed
    )
  ) {
    return "success";
  }
  if (/\b(?:\d{1,3}%|progress|loading|building)\b/i.test(trimmed)) {
    return "progress";
  }
  if (
    /\b(?:telemetry|copyright|all rights reserved|powered by)\b/i.test(trimmed)
  ) {
    return "boilerplate";
  }
  return "text";
}

export function segmentArtifact(artifact: ArtifactSnapshot): Segment[] {
  return splitRawLines(artifact.bytes).map((line) => ({
    segmentId: `segment:${sha256Text(
      `${artifact.artifactId}:${line.ordinal}:${line.startByte}:${line.endByte}`
    )}`,
    artifactId: artifact.artifactId,
    ordinal: line.ordinal,
    startByte: line.startByte,
    endByte: line.endByte,
    kind: classifyLine(line.text),
    sha256: sha256Base64Url(line.bytes)
  }));
}
