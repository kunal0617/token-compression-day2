import type { ByteRange } from "../contracts/types.js";

export function assertRange(range: ByteRange, byteLength: number): void {
  if (
    !Number.isSafeInteger(range.startByte) ||
    !Number.isSafeInteger(range.endByte) ||
    range.startByte < 0 ||
    range.endByte < range.startByte ||
    range.endByte > byteLength
  ) {
    throw new RangeError(
      `Invalid byte range [${range.startByte}, ${range.endByte}) for ${byteLength} bytes`
    );
  }
}

export function rangesIntersect(left: ByteRange, right: ByteRange): boolean {
  return left.startByte < right.endByte && right.startByte < left.endByte;
}

export function rangeContains(container: ByteRange, nested: ByteRange): boolean {
  return (
    container.startByte <= nested.startByte &&
    container.endByte >= nested.endByte
  );
}

export function mergeRanges(ranges: readonly ByteRange[]): ByteRange[] {
  const ordered = [...ranges].sort(
    (left, right) =>
      left.startByte - right.startByte || left.endByte - right.endByte
  );
  const merged: ByteRange[] = [];

  for (const range of ordered) {
    const previous = merged.at(-1);
    if (previous === undefined || range.startByte > previous.endByte) {
      merged.push({ ...range });
      continue;
    }
    previous.endByte = Math.max(previous.endByte, range.endByte);
  }

  return merged;
}

export function subtractRanges(
  whole: ByteRange,
  omissions: readonly ByteRange[]
): ByteRange[] {
  const output: ByteRange[] = [];
  let cursor = whole.startByte;
  for (const omission of omissions) {
    if (cursor < omission.startByte) {
      output.push({ startByte: cursor, endByte: omission.startByte });
    }
    cursor = omission.endByte;
  }
  if (cursor < whole.endByte) {
    output.push({ startByte: cursor, endByte: whole.endByte });
  }
  return output;
}

