const MAX_PDF_XREF_ENTRIES = 100_000;
const MAX_PDF_XREF_REVISIONS = 32;

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

function matchesKeyword(
  data: Uint8Array,
  offset: number,
  value: string,
): boolean {
  const end = offset + value.length;
  return (
    startsWithAscii(data, offset, value) &&
    (end >= data.length || isPdfDelimiter(data[end]))
  );
}

function skipWhitespaceAndComments(data: Uint8Array, start: number): number {
  let position = start;
  while (position < data.length) {
    if (isPdfWhitespace(data[position])) {
      position += 1;
      continue;
    }
    if (data[position] !== 0x25) return position;
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
  let position = skipWhitespaceAndComments(data, start);
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

function findFinalStartXref(data: Uint8Array): number | null {
  for (let start = data.length - "startxref".length; start >= 0; start -= 1) {
    if (!startsWithAscii(data, start, "startxref")) continue;
    if (!matchesKeyword(data, start, "startxref")) return null;
    const offset = readUnsignedInteger(data, start + "startxref".length);
    if (offset && offset.value >= 0 && offset.value < data.length) {
      return offset.value;
    }
    return null;
  }
  return null;
}

function skipLiteralString(data: Uint8Array, start: number): number {
  let depth = 1;
  let position = start + 1;
  while (position < data.length && depth > 0) {
    if (data[position] === 0x5c) position += 2;
    else {
      if (data[position] === 0x28) depth += 1;
      else if (data[position] === 0x29) depth -= 1;
      position += 1;
    }
  }
  return position;
}

function readTrailerPreviousOffset(
  data: Uint8Array,
  start: number,
): number | null | undefined {
  let position = skipWhitespaceAndComments(data, start);
  if (!startsWithAscii(data, position, "<<")) return undefined;
  position += 2;
  let depth = 1;
  while (position < data.length && depth > 0) {
    position = skipWhitespaceAndComments(data, position);
    if (startsWithAscii(data, position, "<<")) {
      depth += 1;
      position += 2;
      continue;
    }
    if (startsWithAscii(data, position, ">>")) {
      depth -= 1;
      position += 2;
      continue;
    }
    if (data[position] === 0x28) {
      position = skipLiteralString(data, position);
      continue;
    }
    if (data[position] === 0x3c) {
      while (position < data.length && data[position] !== 0x3e) position += 1;
      position += 1;
      continue;
    }
    if (data[position] === 0x2f) {
      const nameStart = position + 1;
      position = nameStart;
      while (position < data.length && !isPdfDelimiter(data[position])) {
        position += 1;
      }
      if (
        depth === 1 &&
        startsWithAscii(data, nameStart, "Prev") &&
        position - nameStart === 4
      ) {
        return readUnsignedInteger(data, position)?.value;
      }
      continue;
    }
    position += 1;
  }
  return depth === 0 ? null : undefined;
}

/** Read active entries from a bounded traditional xref revision chain. */
export function readActivePdfXrefOffsets(
  data: Uint8Array,
): Map<string, number | null> | null {
  let xrefOffset = findFinalStartXref(data);
  if (xrefOffset === null) return null;
  const active = new Map<string, number | null>();
  const seenObjects = new Set<number>();
  const visited = new Set<number>();
  let entries = 0;
  for (let revision = 0; revision < MAX_PDF_XREF_REVISIONS; revision += 1) {
    if (visited.has(xrefOffset)) return null;
    visited.add(xrefOffset);
    let position = skipWhitespaceAndComments(data, xrefOffset);
    if (!matchesKeyword(data, position, "xref")) return null;
    position += 4;
    while (true) {
      position = skipWhitespaceAndComments(data, position);
      if (matchesKeyword(data, position, "trailer")) {
        position += "trailer".length;
        break;
      }
      const firstObject = readUnsignedInteger(data, position);
      if (!firstObject) return null;
      const count = readUnsignedInteger(data, firstObject.end);
      if (!count) return null;
      position = count.end;
      entries += count.value;
      if (entries > MAX_PDF_XREF_ENTRIES) return null;
      const subsection: Array<{
        generation: number;
        offset: number;
        status: number;
      }> = [];
      for (let index = 0; index < count.value; index += 1) {
        const offset = readUnsignedInteger(data, position);
        if (!offset) return null;
        const generation = readUnsignedInteger(data, offset.end);
        if (!generation) return null;
        position = skipWhitespaceAndComments(data, generation.end);
        const status = data[position];
        if (status !== 0x6e && status !== 0x66) return null;
        position += 1;
        while (data[position] === 0x20 || data[position] === 0x09)
          position += 1;
        if (data[position] === 0x0d && data[position + 1] === 0x0a)
          position += 2;
        else if (data[position] === 0x0a || data[position] === 0x0d)
          position += 1;
        else return null;
        subsection.push({
          generation: generation.value,
          offset: offset.value,
          status,
        });
      }
      const normalizedFirstObject =
        firstObject.value === 1 && subsection[0]?.status === 0x66
          ? 0
          : firstObject.value;
      for (let index = 0; index < subsection.length; index += 1) {
        const { generation, offset, status } = subsection[index];
        const objectNumber = normalizedFirstObject + index;
        const key = `${objectNumber}:${generation}`;
        if (!seenObjects.has(objectNumber)) {
          seenObjects.add(objectNumber);
          active.set(key, status === 0x6e ? offset : null);
        }
      }
    }
    const previous = readTrailerPreviousOffset(data, position);
    if (previous === null) return active;
    if (previous === undefined || previous < 0 || previous >= data.length) {
      return null;
    }
    xrefOffset = previous;
  }
  return null;
}
