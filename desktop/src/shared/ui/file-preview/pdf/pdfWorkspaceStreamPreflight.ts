import {
  ascii85Transform,
  asciiHexTransform,
  lzwTransform,
  runLengthTransform,
} from "./pdfWorkspaceStreamDecoders";
import {
  normalizePdfFilterName,
  type PdfFilterName,
  validatePdfFilterOrder,
} from "./pdfWorkspaceStreamFilters";
import {
  assertPdfReferenceOffsetsOutsideRanges,
  indexPdfIndirectObjects,
} from "./pdfWorkspaceReferenceIndex";
import { readActivePdfXrefOffsets } from "./pdfWorkspaceXref";

export const MAX_PDF_DECODED_STREAM_BYTES = 16 * 1_024 * 1_024;
export const MAX_PDF_DECODED_TOTAL_BYTES = 64 * 1_024 * 1_024;
const MAX_PDF_PREFLIGHT_TOKENS = 1_000_000;
const MAX_PDF_DICTIONARY_ENTRIES = 256;
const MAX_PDF_ARRAY_ENTRIES = 1_024;
const MAX_PDF_VALUE_DEPTH = 32;
const MAX_PDF_REFERENCE_DEPTH = 16;

type PdfToken = {
  end: number;
  kind:
    | "arrayEnd"
    | "arrayStart"
    | "dictEnd"
    | "dictStart"
    | "hexString"
    | "name"
    | "number"
    | "string"
    | "word";
  start: number;
  value?: number | string;
};

type PdfReference = { generation: number; objectNumber: number; type: "ref" };
type PdfName = { name: string; type: "name" };
type PdfDictionary = { entries: Map<string, PdfValue>; type: "dictionary" };
type PdfValue =
  | PdfDictionary
  | PdfName
  | PdfReference
  | PdfValue[]
  | boolean
  | null
  | number
  | string;

type PdfStreamDescriptor = {
  dictionary: PdfDictionary;
  end: number;
  start: number;
};

type PreflightBudget = {
  activeReferenceOffsets: Map<string, number | null> | null;
  excludedReferenceRanges: Array<{ end: number; start: number }>;
  referenceOffsets: Map<string, number[]>;
  resolvedReferenceOffsets: Set<number>;
  referenceValues: Map<string, PdfValue | null>;
  tokens: number;
};

export class PdfDecodedStreamLimitError extends Error {
  readonly decodedBytes: number;
  readonly largestChunkBytes: number;

  constructor(
    message: string,
    decodedBytes: number,
    largestChunkBytes: number,
  ) {
    super(message);
    this.name = "PdfDecodedStreamLimitError";
    this.decodedBytes = decodedBytes;
    this.largestChunkBytes = largestChunkBytes;
  }
}

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

function hexDigit(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
}

class PdfByteLexer {
  private readonly budget: PreflightBudget;
  private readonly data: Uint8Array;
  private position: number;

  constructor(data: Uint8Array, budget: PreflightBudget, start = 0) {
    this.data = data;
    this.budget = budget;
    this.position = start;
  }

  seek(position: number): void {
    this.position = position;
  }

  next(): PdfToken | null {
    this.skipWhitespaceAndComments();
    if (this.position >= this.data.length) return null;
    if (this.budget.tokens <= 0) {
      throw new Error("PDF preflight token limit exceeded");
    }
    this.budget.tokens -= 1;
    const start = this.position;
    const byte = this.data[this.position++];

    if (byte === 0x3c && this.data[this.position] === 0x3c) {
      this.position += 1;
      return { end: this.position, kind: "dictStart", start };
    }
    if (byte === 0x3e && this.data[this.position] === 0x3e) {
      this.position += 1;
      return { end: this.position, kind: "dictEnd", start };
    }
    if (byte === 0x5b) return { end: this.position, kind: "arrayStart", start };
    if (byte === 0x5d) return { end: this.position, kind: "arrayEnd", start };
    if (byte === 0x28)
      return this.excludeReferenceRange(this.readLiteralString(start));
    if (byte === 0x3c)
      return this.excludeReferenceRange(this.readHexString(start));
    if (byte === 0x2f) return this.excludeReferenceRange(this.readName(start));

    while (
      this.position < this.data.length &&
      !isPdfDelimiter(this.data[this.position])
    ) {
      this.position += 1;
    }
    if (this.position - start > 64) {
      throw new Error("PDF token is too long");
    }
    const value = new TextDecoder("ascii").decode(
      this.data.subarray(start, this.position),
    );
    const number = Number(value);
    if (value.length > 0 && Number.isFinite(number)) {
      return { end: this.position, kind: "number", start, value: number };
    }
    return { end: this.position, kind: "word", start, value };
  }

  private readHexString(start: number): PdfToken {
    while (
      this.position < this.data.length &&
      this.data[this.position] !== 0x3e
    ) {
      this.position += 1;
    }
    if (this.position >= this.data.length) {
      throw new Error("PDF hex string is invalid");
    }
    this.position += 1;
    return { end: this.position, kind: "hexString", start };
  }

  private readLiteralString(start: number): PdfToken {
    let depth = 1;
    while (this.position < this.data.length && depth > 0) {
      const byte = this.data[this.position++];
      if (byte === 0x5c) {
        if (this.position < this.data.length) this.position += 1;
      } else if (byte === 0x28) {
        depth += 1;
        if (depth > MAX_PDF_VALUE_DEPTH) {
          throw new Error("PDF string nesting limit exceeded");
        }
      } else if (byte === 0x29) {
        depth -= 1;
      }
    }
    if (depth !== 0) throw new Error("PDF string is invalid");
    return { end: this.position, kind: "string", start };
  }

  private readName(start: number): PdfToken {
    const decoded: number[] = [];
    while (
      this.position < this.data.length &&
      !isPdfDelimiter(this.data[this.position])
    ) {
      const byte = this.data[this.position++];
      if (byte === 0x23) {
        const high = hexDigit(this.data[this.position]);
        const low = hexDigit(this.data[this.position + 1]);
        if (high < 0 || low < 0) throw new Error("PDF name escape is invalid");
        decoded.push(high * 16 + low);
        this.position += 2;
      } else {
        decoded.push(byte);
      }
      if (decoded.length > 256) throw new Error("PDF name is too long");
    }
    return {
      end: this.position,
      kind: "name",
      start,
      value: new TextDecoder("iso-8859-1").decode(new Uint8Array(decoded)),
    };
  }

  private excludeReferenceRange(token: PdfToken): PdfToken {
    this.budget.excludedReferenceRanges.push({
      end: token.end,
      start: token.start,
    });
    return token;
  }

  private skipWhitespaceAndComments(): void {
    while (this.position < this.data.length) {
      if (isPdfWhitespace(this.data[this.position])) {
        this.position += 1;
        continue;
      }
      if (this.data[this.position] !== 0x25) return;
      const start = this.position;
      this.position += 1;
      while (
        this.position < this.data.length &&
        this.data[this.position] !== 0x0a &&
        this.data[this.position] !== 0x0d
      ) {
        this.position += 1;
      }
      this.budget.excludedReferenceRanges.push({ end: this.position, start });
    }
  }
}

class PdfTokenReader {
  private readonly lexer: PdfByteLexer;
  private readonly buffered: PdfToken[] = [];

  constructor(lexer: PdfByteLexer) {
    this.lexer = lexer;
  }

  peek(offset = 0): PdfToken | null {
    while (this.buffered.length <= offset) {
      const token = this.lexer.next();
      if (!token) return null;
      this.buffered.push(token);
    }
    return this.buffered[offset];
  }

  take(): PdfToken | null {
    return this.buffered.shift() ?? this.lexer.next();
  }

  seek(position: number): void {
    this.buffered.length = 0;
    this.lexer.seek(position);
  }
}

function tokenIs(
  token: PdfToken | null,
  kind: PdfToken["kind"],
  value?: string,
): boolean {
  return token?.kind === kind && (value === undefined || token.value === value);
}

function parsePdfValue(reader: PdfTokenReader, depth = 0): PdfValue {
  if (depth > MAX_PDF_VALUE_DEPTH) {
    throw new Error("PDF value nesting limit exceeded");
  }
  const token = reader.take();
  if (!token) throw new Error("PDF value is missing");
  if (token.kind === "dictStart") {
    const entries = new Map<string, PdfValue>();
    while (!tokenIs(reader.peek(), "dictEnd")) {
      if (entries.size >= MAX_PDF_DICTIONARY_ENTRIES) {
        throw new Error("PDF dictionary entry limit exceeded");
      }
      const key = reader.take();
      if (!tokenIs(key, "name"))
        throw new Error("PDF dictionary key is invalid");
      const name = String(key?.value);
      if (entries.has(name))
        throw new Error("PDF dictionary key is duplicated");
      entries.set(name, parsePdfValue(reader, depth + 1));
    }
    reader.take();
    return { entries, type: "dictionary" };
  }
  if (token.kind === "arrayStart") {
    const values: PdfValue[] = [];
    while (!tokenIs(reader.peek(), "arrayEnd")) {
      if (values.length >= MAX_PDF_ARRAY_ENTRIES) {
        throw new Error("PDF array entry limit exceeded");
      }
      values.push(parsePdfValue(reader, depth + 1));
    }
    reader.take();
    return values;
  }
  if (token.kind === "number") {
    if (
      tokenIs(reader.peek(), "number") &&
      tokenIs(reader.peek(1), "word", "R")
    ) {
      const generation = reader.take();
      reader.take();
      if (
        !Number.isSafeInteger(token.value) ||
        !Number.isSafeInteger(generation?.value) ||
        Number(token.value) < 0 ||
        Number(generation?.value) < 0
      ) {
        throw new Error("PDF reference is invalid");
      }
      return {
        generation: Number(generation?.value),
        objectNumber: Number(token.value),
        type: "ref",
      };
    }
    return Number(token.value);
  }
  if (token.kind === "name") return { name: String(token.value), type: "name" };
  if (token.kind === "word") {
    if (token.value === "null") return null;
    if (token.value === "true") return true;
    if (token.value === "false") return false;
    return String(token.value);
  }
  if (token.kind === "hexString" || token.kind === "string") return "opaque";
  throw new Error("PDF value is invalid");
}

function isDictionary(value: PdfValue | undefined): value is PdfDictionary {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "entries" in value
  );
}

function isReference(value: PdfValue | undefined): value is PdfReference {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "objectNumber" in value
  );
}

function isName(value: PdfValue | undefined, name?: string): value is PdfName {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "name" in value &&
    (name === undefined || value.name === name)
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

function streamDataStart(data: Uint8Array, keywordEnd: number): number {
  let position = keywordEnd;
  while (data[position] === 0x20 || data[position] === 0x09) position += 1;
  if (data[position] === 0x0d && data[position + 1] === 0x0a)
    return position + 2;
  if (data[position] === 0x0a || data[position] === 0x0d) return position + 1;
  throw new Error("PDF stream start is invalid");
}

function streamDataEnd(
  data: Uint8Array,
  start: number,
  length: number,
): number {
  const end = start + length;
  if (!Number.isSafeInteger(length) || length < 0 || end > data.length) {
    throw new Error("PDF stream length is invalid");
  }
  let marker = end;
  if (data[marker] === 0x0d && data[marker + 1] === 0x0a) marker += 2;
  else if (data[marker] === 0x0a || data[marker] === 0x0d) marker += 1;
  if (!startsWithAscii(data, marker, "endstream")) {
    throw new Error("PDF stream length is invalid");
  }
  return end;
}

function pdfValuesEqual(left: PdfValue, right: PdfValue): boolean {
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return left === right;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => pdfValuesEqual(entry, right[index]))
    );
  }
  if (isReference(left) || isReference(right)) {
    return (
      isReference(left) &&
      isReference(right) &&
      left.objectNumber === right.objectNumber &&
      left.generation === right.generation
    );
  }
  if (isName(left) || isName(right)) {
    return isName(left) && isName(right) && left.name === right.name;
  }
  if (
    !isDictionary(left) ||
    !isDictionary(right) ||
    left.entries.size !== right.entries.size
  ) {
    return false;
  }
  return [...left.entries].every(([key, value]) => {
    const other = right.entries.get(key);
    return other !== undefined && pdfValuesEqual(value, other);
  });
}

function parseIndirectCandidate(
  data: Uint8Array,
  reference: PdfReference,
  budget: PreflightBudget,
  start: number,
): PdfValue | null {
  const reader = new PdfTokenReader(new PdfByteLexer(data, budget, start));
  const objectNumber = reader.take();
  const generation = reader.take();
  const objectKeyword = reader.take();
  if (
    !tokenIs(objectNumber, "number") ||
    objectNumber?.value !== reference.objectNumber ||
    !tokenIs(generation, "number") ||
    generation?.value !== reference.generation ||
    !tokenIs(objectKeyword, "word", "obj")
  ) {
    return null;
  }
  const value = parsePdfValue(reader);
  return tokenIs(reader.take(), "word", "endobj") ? value : null;
}

function findIndirectValue(
  data: Uint8Array,
  reference: PdfReference,
  budget: PreflightBudget,
): PdfValue | null {
  const key = `${reference.objectNumber}:${reference.generation}`;
  if (budget.referenceValues.has(key)) {
    return budget.referenceValues.get(key) ?? null;
  }
  const candidates = budget.referenceOffsets.get(key) ?? [];
  let start: number | undefined;
  let resolved: PdfValue | null = null;
  if (budget.activeReferenceOffsets !== null) {
    if (!budget.activeReferenceOffsets.has(key)) {
      budget.referenceValues.set(key, null);
      return null;
    }
    start = budget.activeReferenceOffsets.get(key) ?? undefined;
    if (start === undefined || !candidates.includes(start)) {
      budget.referenceValues.set(key, null);
      return null;
    }
    resolved = parseIndirectCandidate(data, reference, budget, start);
  } else {
    const parsed = candidates
      .map((offset) => ({
        offset,
        value: parseIndirectCandidate(data, reference, budget, offset),
      }))
      .filter(
        (candidate): candidate is { offset: number; value: PdfValue } =>
          candidate.value !== null,
      );
    const first = parsed[0];
    if (
      !first ||
      parsed.some((candidate) => !pdfValuesEqual(first.value, candidate.value))
    ) {
      budget.referenceValues.set(key, null);
      return null;
    }
    start = first.offset;
    resolved = first.value;
  }
  if (start === undefined || resolved === null) {
    budget.referenceValues.set(key, null);
    return null;
  }
  budget.referenceValues.set(key, resolved);
  budget.resolvedReferenceOffsets.add(start);
  return resolved;
}

function resolveIndirectValue(
  data: Uint8Array,
  value: PdfValue | undefined,
  budget: PreflightBudget,
): PdfValue | undefined {
  const visited = new Set<string>();
  let current = value;
  for (let depth = 0; depth <= MAX_PDF_REFERENCE_DEPTH; depth += 1) {
    if (!isReference(current)) return current;
    const key = `${current.objectNumber}:${current.generation}`;
    if (visited.has(key)) break;
    visited.add(key);
    current = findIndirectValue(data, current, budget) ?? undefined;
  }
  return undefined;
}

function resolveStreamLength(
  data: Uint8Array,
  value: PdfValue | undefined,
  budget: PreflightBudget,
): number {
  const current = resolveIndirectValue(data, value, budget);
  if (
    typeof current === "number" &&
    Number.isSafeInteger(current) &&
    current >= 0
  ) {
    return current;
  }
  throw new Error("PDF stream length is invalid");
}

function assertReferencesOutsideStreams(
  budget: PreflightBudget,
  streams: PdfStreamDescriptor[],
): void {
  assertPdfReferenceOffsetsOutsideRanges(budget.resolvedReferenceOffsets, [
    ...budget.excludedReferenceRanges,
    ...streams.map(({ start, end }) => ({ end, start })),
  ]);
}

function readStreamDescriptorAt(
  data: Uint8Array,
  budget: PreflightBudget,
  objectOffset: number,
  expectedKey: string,
): PdfStreamDescriptor | null {
  const reader = new PdfTokenReader(
    new PdfByteLexer(data, budget, objectOffset),
  );
  const objectNumber = reader.take();
  const generation = reader.take();
  if (
    !tokenIs(objectNumber, "number") ||
    !tokenIs(generation, "number") ||
    `${objectNumber?.value}:${generation?.value}` !== expectedKey ||
    !tokenIs(reader.take(), "word", "obj")
  ) {
    throw new Error("PDF xref object offset is invalid");
  }
  const value = parsePdfValue(reader);
  if (!isDictionary(value) || !tokenIs(reader.peek(), "word", "stream")) {
    return null;
  }
  const streamToken = reader.take();
  const start = streamDataStart(data, streamToken?.end ?? -1);
  const length = resolveStreamLength(data, value.entries.get("Length"), budget);
  const end = streamDataEnd(data, start, length);
  return { dictionary: value, end, start };
}

function scanPdfStreams(
  data: Uint8Array,
  budget: PreflightBudget,
): PdfStreamDescriptor[] {
  if (budget.activeReferenceOffsets !== null) {
    const active = [...budget.activeReferenceOffsets]
      .filter((entry): entry is [string, number] => entry[1] !== null)
      .sort((left, right) => left[1] - right[1]);
    return active.flatMap(([key, offset]) => {
      const descriptor = readStreamDescriptorAt(data, budget, offset, key);
      return descriptor ? [descriptor] : [];
    });
  }
  const reader = new PdfTokenReader(new PdfByteLexer(data, budget));
  const streams: PdfStreamDescriptor[] = [];
  while (true) {
    const objectNumber = reader.take();
    if (!objectNumber) return streams;
    if (
      !tokenIs(objectNumber, "number") ||
      !tokenIs(reader.peek(), "number") ||
      !tokenIs(reader.peek(1), "word", "obj")
    ) {
      continue;
    }
    reader.take();
    reader.take();
    const value = parsePdfValue(reader);
    if (!isDictionary(value) || !tokenIs(reader.peek(), "word", "stream")) {
      continue;
    }
    const streamToken = reader.take();
    const start = streamDataStart(data, streamToken?.end ?? -1);
    const length = resolveStreamLength(
      data,
      value.entries.get("Length"),
      budget,
    );
    const end = streamDataEnd(data, start, length);
    streams.push({ dictionary: value, end, start });
    let afterMarker = end;
    if (data[afterMarker] === 0x0d && data[afterMarker + 1] === 0x0a)
      afterMarker += 2;
    else if (data[afterMarker] === 0x0a || data[afterMarker] === 0x0d)
      afterMarker += 1;
    reader.seek(afterMarker + "endstream".length);
  }
}

function readFilterNames(
  data: Uint8Array,
  dictionary: PdfDictionary,
  budget: PreflightBudget,
): PdfFilterName[] {
  const value = resolveIndirectValue(
    data,
    dictionary.entries.get("Filter"),
    budget,
  );
  if (value === undefined) return [];
  const names = Array.isArray(value) ? value : [value];
  if (names.length < 1 || names.length > 4) {
    throw new Error("unsupported PDF stream filter chain");
  }
  return names.map((entry) => {
    const resolved = resolveIndirectValue(data, entry, budget);
    if (!isName(resolved)) throw new Error("PDF stream filter is invalid");
    const filter = normalizePdfFilterName(resolved.name);
    if (!filter) throw new Error("unsupported PDF stream filter");
    return filter;
  });
}

function readDecodeParameters(
  data: Uint8Array,
  dictionary: PdfDictionary,
  filterCount: number,
  budget: PreflightBudget,
): Array<PdfDictionary | null> {
  const resolveDictionary = (entry: PdfDictionary): PdfDictionary => {
    const entries = new Map(entry.entries);
    for (const name of [
      "BitsPerComponent",
      "Colors",
      "Columns",
      "EarlyChange",
      "Predictor",
    ]) {
      if (!entries.has(name)) continue;
      const resolved = resolveIndirectValue(data, entries.get(name), budget);
      if (resolved === undefined) {
        throw new Error("PDF decode parameters are invalid");
      }
      entries.set(name, resolved);
    }
    return { entries, type: "dictionary" };
  };
  const value = resolveIndirectValue(
    data,
    dictionary.entries.get("DecodeParms") ?? dictionary.entries.get("DP"),
    budget,
  );
  if (value === undefined || value === null)
    return Array(filterCount).fill(null);
  if (Array.isArray(value)) {
    if (value.length !== filterCount)
      throw new Error("PDF decode parameters are invalid");
    return value.map((entry) => {
      const resolved = resolveIndirectValue(data, entry, budget);
      if (resolved === null) return resolved;
      if (isDictionary(resolved)) return resolveDictionary(resolved);
      throw new Error("PDF decode parameters are invalid");
    });
  }
  if (filterCount === 1 && isDictionary(value)) {
    return [resolveDictionary(value)];
  }
  throw new Error("PDF decode parameters are invalid");
}

function readPositiveIntegerParameter(
  parameters: PdfDictionary,
  name: string,
  fallback: number,
): number {
  const value = parameters.entries.get(name) ?? fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("PDF predictor parameters are invalid");
  }
  return value;
}

function minimumPredictorRowBytes(
  parameters: PdfDictionary | null,
  maxStreamBytes: number,
): number {
  if (!parameters) return 0;
  const predictor = parameters.entries.get("Predictor") ?? 1;
  if (
    typeof predictor !== "number" ||
    !Number.isInteger(predictor) ||
    ![1, 2, 10, 11, 12, 13, 14, 15].includes(predictor)
  ) {
    throw new Error("unsupported PDF predictor");
  }
  if (predictor === 1) return 0;

  const bitsPerComponent = readPositiveIntegerParameter(
    parameters,
    "BitsPerComponent",
    8,
  );
  if (![1, 2, 4, 8, 16].includes(bitsPerComponent)) {
    throw new Error("PDF predictor parameters are invalid");
  }
  const colors = readPositiveIntegerParameter(parameters, "Colors", 1);
  const columns = readPositiveIntegerParameter(parameters, "Columns", 1);
  const rowBits = colors * columns * bitsPerComponent;
  if (!Number.isSafeInteger(rowBits)) {
    throw new Error("PDF predictor parameters are invalid");
  }
  const rowBytes = Math.ceil(rowBits / 8) + (predictor >= 10 ? 1 : 0);
  if (!Number.isSafeInteger(rowBytes) || rowBytes > maxStreamBytes) {
    throw new Error("PDF predictor row exceeds decoded stream limit");
  }
  return rowBytes;
}

function readEarlyChange(parameters: PdfDictionary | null): number {
  if (!parameters) return 1;
  const value = parameters.entries.get("EarlyChange") ?? 1;
  if (value !== 0 && value !== 1)
    throw new Error("PDF LZW parameters are invalid");
  return value;
}

type DecodedBudget = {
  add: (bytes: number) => void;
  largestChunk: () => number;
};

function createDecodedBudget(
  maxStreamBytes: number,
  maxDocumentBytes: number,
  total: { bytes: number },
): DecodedBudget {
  let streamBytes = 0;
  let largestChunk = 0;
  return {
    add(bytes) {
      largestChunk = Math.max(largestChunk, bytes);
      streamBytes += bytes;
      total.bytes += bytes;
      if (streamBytes > maxStreamBytes) {
        throw new PdfDecodedStreamLimitError(
          "PDF decoded stream limit exceeded",
          streamBytes,
          largestChunk,
        );
      }
      if (total.bytes > maxDocumentBytes) {
        throw new PdfDecodedStreamLimitError(
          "PDF decoded document limit exceeded",
          total.bytes,
          largestChunk,
        );
      }
    },
    largestChunk: () => largestChunk,
  };
}

function countingTransform(
  budget: DecodedBudget,
  onChunk?: (bytes: number) => void,
): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream({
    transform(chunk, controller) {
      budget.add(chunk.byteLength);
      onChunk?.(chunk.byteLength);
      controller.enqueue(chunk);
    },
  });
}

async function decodeStreamWithinBudget(
  encoded: Uint8Array,
  filters: PdfFilterName[],
  parameters: Array<PdfDictionary | null>,
  budget: DecodedBudget,
  maxStreamBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  const copy = new Uint8Array(encoded);
  let stream: ReadableStream<Uint8Array> = new Blob([copy]).stream();
  let finalDecodedBytes = 0;
  let requiredPredictorRowBytes = 0;
  for (let index = 0; index < filters.length; index += 1) {
    const filter = filters[index];
    if (filter === "ASCII85Decode")
      stream = stream.pipeThrough(ascii85Transform());
    else if (filter === "ASCIIHexDecode")
      stream = stream.pipeThrough(asciiHexTransform());
    else if (filter === "FlateDecode") {
      requiredPredictorRowBytes = minimumPredictorRowBytes(
        parameters[index],
        maxStreamBytes,
      );
      stream = stream.pipeThrough(
        new DecompressionStream("deflate") as unknown as ReadableWritablePair<
          Uint8Array,
          Uint8Array
        >,
      );
    } else if (filter === "LZWDecode") {
      requiredPredictorRowBytes = minimumPredictorRowBytes(
        parameters[index],
        maxStreamBytes,
      );
      stream = stream.pipeThrough(
        lzwTransform(readEarlyChange(parameters[index])),
      );
    } else if (filter === "RunLengthDecode") {
      stream = stream.pipeThrough(runLengthTransform());
    } else {
      break;
    }
  }
  stream = stream.pipeThrough(
    countingTransform(budget, (bytes) => {
      finalDecodedBytes += bytes;
    }),
  );
  const reader = stream.getReader();
  const abort = () => void reader.cancel();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new Error("PDF preflight was cancelled");
      const chunk = await reader.read();
      if (chunk.done) {
        if (
          requiredPredictorRowBytes > 0 &&
          finalDecodedBytes < requiredPredictorRowBytes
        ) {
          throw new Error("PDF predictor row exceeds decoded stream data");
        }
        return;
      }
    }
  } catch (cause) {
    if (cause instanceof PdfDecodedStreamLimitError) throw cause;
    if (cause instanceof Error && cause.message.startsWith("PDF predictor")) {
      throw cause;
    }
    if (signal?.aborted) throw new Error("PDF preflight was cancelled");
    throw new Error("PDF filtered stream is invalid", { cause });
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function assertPdfDecodedStreamBudget(
  data: Uint8Array,
  options: {
    maxDocumentBytes?: number;
    maxStreamBytes?: number;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const maxStreamBytes = Math.floor(
    finitePositive(
      options.maxStreamBytes ?? MAX_PDF_DECODED_STREAM_BYTES,
      MAX_PDF_DECODED_STREAM_BYTES,
    ),
  );
  const maxDocumentBytes = Math.floor(
    finitePositive(
      options.maxDocumentBytes ?? MAX_PDF_DECODED_TOTAL_BYTES,
      MAX_PDF_DECODED_TOTAL_BYTES,
    ),
  );
  const tokenBudget: PreflightBudget = {
    activeReferenceOffsets: null,
    excludedReferenceRanges: [],
    referenceOffsets: indexPdfIndirectObjects(data),
    resolvedReferenceOffsets: new Set<number>(),
    referenceValues: new Map<string, PdfValue | null>(),
    tokens: MAX_PDF_PREFLIGHT_TOKENS,
  };
  tokenBudget.activeReferenceOffsets = readActivePdfXrefOffsets(data);
  const total = { bytes: 0 };
  const descriptors = scanPdfStreams(data, tokenBudget);
  assertReferencesOutsideStreams(tokenBudget, descriptors);
  const prepared = descriptors.map((descriptor) => {
    const filters = readFilterNames(data, descriptor.dictionary, tokenBudget);
    const parameters = readDecodeParameters(
      data,
      descriptor.dictionary,
      filters.length,
      tokenBudget,
    );
    const isImageStream = isName(
      descriptor.dictionary.entries.get("Subtype"),
      "Image",
    );
    validatePdfFilterOrder(filters, isImageStream);
    return { descriptor, filters, parameters };
  });
  assertReferencesOutsideStreams(tokenBudget, descriptors);
  for (const { descriptor, filters, parameters } of prepared) {
    if (options.signal?.aborted) throw new Error("PDF preflight was cancelled");
    const budget = createDecodedBudget(maxStreamBytes, maxDocumentBytes, total);
    if (filters.length === 0) {
      budget.add(descriptor.end - descriptor.start);
      continue;
    }
    await decodeStreamWithinBudget(
      data.subarray(descriptor.start, descriptor.end),
      filters,
      parameters,
      budget,
      maxStreamBytes,
      options.signal,
    );
  }
}
