const MAX_PDF_REFERENCE_CANDIDATES = 32;
const MAX_PDF_REFERENCE_OBJECTS = 100_000;

function isPdfWhitespace(byte: number): boolean {
  return (
    byte === 0 ||
    byte === 9 ||
    byte === 10 ||
    byte === 12 ||
    byte === 13 ||
    byte === 32
  );
}

function isPdfDelimiter(byte: number): boolean {
  return (
    isPdfWhitespace(byte) ||
    byte === 0x25 ||
    byte === 0x28 ||
    byte === 0x29 ||
    byte === 0x2f ||
    byte === 0x3c ||
    byte === 0x3e ||
    byte === 0x5b ||
    byte === 0x5d ||
    byte === 0x7b ||
    byte === 0x7d
  );
}

function startsWithAscii(
  data: Uint8Array,
  offset: number,
  value: string,
): boolean {
  if (offset < 0 || offset + value.length > data.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (data[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function skipPdfWhitespaceAndComments(data: Uint8Array, start: number): number {
  let position = start;
  while (position < data.length) {
    if (isPdfWhitespace(data[position])) {
      position += 1;
      continue;
    }
    if (data[position] !== 0x25) return position;
    position += 1;
    while (
      position < data.length &&
      data[position] !== 0x0a &&
      data[position] !== 0x0d
    ) {
      position += 1;
    }
  }
  return position;
}

function readUnsignedInteger(
  data: Uint8Array,
  start: number,
): { end: number; value: number } | null {
  let position = start;
  let value = 0;
  let digits = 0;
  while (
    position < data.length &&
    data[position] >= 0x30 &&
    data[position] <= 0x39
  ) {
    value = value * 10 + data[position] - 0x30;
    digits += 1;
    position += 1;
    if (digits > 16 || !Number.isSafeInteger(value)) return null;
  }
  return digits > 0 ? { end: position, value } : null;
}

/** Index indirect object headers in one bounded pass over the raw PDF bytes. */
export function indexPdfIndirectObjects(
  data: Uint8Array,
): Map<string, number[]> {
  const offsets = new Map<string, number[]>();
  let objectCount = 0;
  for (let start = 0; start < data.length; start += 1) {
    if (data[start] < 0x30 || data[start] > 0x39) continue;
    if (start > 0 && !isPdfDelimiter(data[start - 1])) continue;
    const objectNumber = readUnsignedInteger(data, start);
    if (!objectNumber) continue;
    let position = skipPdfWhitespaceAndComments(data, objectNumber.end);
    if (position === objectNumber.end) continue;
    const generation = readUnsignedInteger(data, position);
    if (!generation) continue;
    position = skipPdfWhitespaceAndComments(data, generation.end);
    if (
      position === generation.end ||
      !startsWithAscii(data, position, "obj")
    ) {
      continue;
    }
    const keywordEnd = position + 3;
    if (keywordEnd < data.length && !isPdfDelimiter(data[keywordEnd])) continue;
    const key = `${objectNumber.value}:${generation.value}`;
    const candidates = offsets.get(key) ?? [];
    if (candidates.length >= MAX_PDF_REFERENCE_CANDIDATES) {
      throw new Error("PDF reference candidate limit exceeded");
    }
    objectCount += 1;
    if (objectCount > MAX_PDF_REFERENCE_OBJECTS) {
      throw new Error("PDF indirect object limit exceeded");
    }
    candidates.push(start);
    offsets.set(key, candidates);
    start = keywordEnd - 1;
  }
  return offsets;
}

/** Reject resolved object headers that occur inside excluded byte ranges. */
export function assertPdfReferenceOffsetsOutsideRanges(
  offsets: Set<number>,
  ranges: Array<{ end: number; start: number }>,
): void {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const excluded: Array<{ end: number; start: number }> = [];
  for (const range of sorted) {
    const previous = excluded.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      excluded.push({ ...range });
    }
  }
  for (const offset of offsets) {
    let low = 0;
    let high = excluded.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const range = excluded[middle];
      if (offset < range.start) high = middle - 1;
      else if (offset >= range.end) low = middle + 1;
      else throw new Error("PDF indirect reference location is invalid");
    }
  }
}
