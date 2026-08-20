const MIN_PDF_SCALE = 0.5;
const MAX_PDF_SCALE = 2.5;
export const MAX_PDF_CANVAS_PIXELS = 4_000_000;
export const MAX_PDF_CANVAS_DIMENSION = 8_192;
export const MAX_PDF_CSS_DIMENSION = 8_192;
export const MAX_PDF_IMAGE_PIXELS = 16_000_000;
export const MAX_PDF_CANVAS_AREA_BYTES = 64 * 1_024 * 1_024;
export const MAX_PDF_WORKSPACE_PAGES = 500;
export const MAX_PDF_DECODED_STREAM_BYTES = 16 * 1_024 * 1_024;
export const MAX_PDF_DECODED_TOTAL_BYTES = 64 * 1_024 * 1_024;
export const MAX_PDF_OPERATOR_WORK_PER_PAGE = 100_000;
export const MAX_PDF_TEXT_CHARS_PER_PAGE = 200_000;
export const MAX_PDF_TEXT_CHARS_TOTAL = 2_000_000;
export const MAX_PDF_TEXT_ITEMS_PER_PAGE = 50_000;
export const MAX_PDF_TEXT_ITEMS_TOTAL = 500_000;
export const PDF_WORKSPACE_RENDER_INTENT = "display" as const;

export type PdfCanvasMetrics = {
  cssHeight: number;
  cssWidth: number;
  outputScale: number;
  pageScaleMultiplier: number;
  pixelHeight: number;
  pixelWidth: number;
};

export type ExtractedPdfPageText = {
  text: string;
  truncated: boolean;
};

export type PdfDocumentOptions = {
  canvasMaxAreaInBytes: number;
  data: Uint8Array;
  maxImageSize: number;
  stopAtErrors: boolean;
};

export type PdfTextBudgetResult = {
  consumedCharacters: number;
  consumedItems: number;
  items: Array<{ str: string }>;
  retainedCharacters: number;
  truncated: boolean;
};

export type PdfOperatorBudget = {
  consumedOperations: () => number;
  operationsFilter: (operationIndex: number) => boolean;
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

/** Keep workspace PDF zoom inside the supported 50% to 250% range. */
export function clampPdfScale(value: number): number {
  return Math.min(MAX_PDF_SCALE, Math.max(MIN_PDF_SCALE, value));
}

/** Decode the raw base64 payload supplied by the workspace file loader. */
export function decodePdfBytes(bytesBase64: string): Uint8Array {
  const binary = globalThis.atob(bytesBase64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Apply decode limits before PDF.js inspects image dictionaries or canvases. */
export function createPdfDocumentOptions(data: Uint8Array): PdfDocumentOptions {
  return {
    canvasMaxAreaInBytes: MAX_PDF_CANVAS_AREA_BYTES,
    data,
    maxImageSize: MAX_PDF_IMAGE_PIXELS,
    stopAtErrors: true,
  };
}

/** Re-run zero-operation pages tolerantly so discarded content is detectable. */
export function createPdfDocumentProbeOptions(
  data: Uint8Array,
): PdfDocumentOptions {
  return {
    ...createPdfDocumentOptions(data),
    stopAtErrors: false,
  };
}

function findDictionaryStart(source: string, dictionaryEnd: number): number {
  let depth = 1;
  for (let index = dictionaryEnd - 1; index >= 1; index -= 1) {
    const token = source.slice(index - 1, index + 1);
    if (token === ">>") {
      depth += 1;
      index -= 1;
    } else if (token === "<<") {
      depth -= 1;
      if (depth === 0) return index - 1;
      index -= 1;
    }
  }
  return -1;
}

function resolvePdfStreamLength(
  dictionary: string,
  source: string,
): number | null {
  const indirect = dictionary.match(/\/Length\s+(\d+)\s+(\d+)\s+R\b/);
  if (indirect) {
    const objectPattern = new RegExp(
      `(?:^|\\s)${indirect[1]}\\s+${indirect[2]}\\s+obj\\s+(\\d+)\\s+endobj\\b`,
    );
    const object = source.match(objectPattern);
    return object ? Number.parseInt(object[1], 10) : null;
  }

  const direct = dictionary.match(/\/Length\s+(\d+)\b/);
  return direct ? Number.parseInt(direct[1], 10) : null;
}

type PdfStreamFilterKind = "bounded" | "flate" | "image";

function classifyPdfStreamFilter(dictionary: string): PdfStreamFilterKind {
  const filter = dictionary.match(
    /\/Filter\s*(\/[A-Za-z0-9]+|\[[\s\S]*?\])\s*(?:\/|>>|$)/,
  );
  if (!filter) return "bounded";
  const names = filter[1].match(/\/[A-Za-z0-9]+/g) ?? [];
  if (names.length !== 1) {
    throw new Error("unsupported PDF stream filter chain");
  }
  if (names[0] === "/FlateDecode" || names[0] === "/Fl") return "flate";
  if (names[0] === "/ASCII85Decode" || names[0] === "/ASCIIHexDecode") {
    return "bounded";
  }
  if (
    /\/Subtype\s*\/Image\b/.test(dictionary) &&
    ["/CCITTFaxDecode", "/DCTDecode", "/JBIG2Decode", "/JPXDecode"].includes(
      names[0],
    )
  ) {
    return "image";
  }
  throw new Error("unsupported PDF stream filter");
}

function pdfStreamDataEnd(
  source: string,
  streamStart: number,
  length: number,
): number {
  const streamEnd = streamStart + length;
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    streamEnd > source.length
  ) {
    throw new Error("PDF stream length is invalid");
  }
  let markerStart = streamEnd;
  if (source.startsWith("\r\n", markerStart)) markerStart += 2;
  else if (
    source.charCodeAt(markerStart) === 0x0a ||
    source.charCodeAt(markerStart) === 0x0d
  ) {
    markerStart += 1;
  }
  if (!source.startsWith("endstream", markerStart)) {
    throw new Error("PDF stream length is invalid");
  }
  return streamEnd;
}

/**
 * Stream-decode every directly Flate-encoded PDF stream before PDF.js starts.
 * This rejects compression bombs without retaining their decoded contents.
 */
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
  const source = new TextDecoder("iso-8859-1").decode(data);
  const streamPattern = /\bstream(?:\r\n|\n|\r)/g;
  let totalDecodedBytes = 0;
  let streamMatch = streamPattern.exec(source);

  while (streamMatch) {
    if (options.signal?.aborted) throw new Error("PDF preflight was cancelled");
    const dictionaryEnd = source.lastIndexOf(">>", streamMatch.index);
    const dictionaryStart = findDictionaryStart(source, dictionaryEnd);
    if (dictionaryEnd < 0 || dictionaryStart < 0) {
      throw new Error("PDF stream dictionary is invalid");
    }
    const dictionary = source.slice(dictionaryStart, dictionaryEnd + 2);
    const filterKind = classifyPdfStreamFilter(dictionary);

    const length = resolvePdfStreamLength(dictionary, source);
    if (length === null) throw new Error("PDF stream length is invalid");
    const streamStart = streamMatch.index + streamMatch[0].length;
    const streamEnd = pdfStreamDataEnd(source, streamStart, length);
    streamPattern.lastIndex = streamEnd;
    if (filterKind === "bounded") {
      totalDecodedBytes += length;
      if (length > maxStreamBytes) {
        throw new PdfDecodedStreamLimitError(
          "PDF decoded stream limit exceeded",
          length,
          0,
        );
      }
      if (totalDecodedBytes > maxDocumentBytes) {
        throw new PdfDecodedStreamLimitError(
          "PDF decoded document limit exceeded",
          totalDecodedBytes,
          0,
        );
      }
      streamMatch = streamPattern.exec(source);
      continue;
    }
    if (filterKind === "image") {
      streamMatch = streamPattern.exec(source);
      continue;
    }
    const compressed = new Uint8Array(data.subarray(streamStart, streamEnd));
    const decoded = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream("deflate"));
    const reader = decoded.getReader();
    let streamDecodedBytes = 0;
    let largestChunkBytes = 0;
    const abort = () => {
      void reader.cancel();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        largestChunkBytes = Math.max(largestChunkBytes, chunk.value.byteLength);
        streamDecodedBytes += chunk.value.byteLength;
        totalDecodedBytes += chunk.value.byteLength;
        if (streamDecodedBytes > maxStreamBytes) {
          await reader.cancel();
          throw new PdfDecodedStreamLimitError(
            "PDF decoded stream limit exceeded",
            streamDecodedBytes,
            largestChunkBytes,
          );
        }
        if (totalDecodedBytes > maxDocumentBytes) {
          await reader.cancel();
          throw new PdfDecodedStreamLimitError(
            "PDF decoded document limit exceeded",
            totalDecodedBytes,
            largestChunkBytes,
          );
        }
      }
    } catch (cause) {
      if (cause instanceof PdfDecodedStreamLimitError) throw cause;
      if (options.signal?.aborted) {
        throw new Error("PDF preflight was cancelled");
      }
      throw new Error("PDF Flate stream is invalid", { cause });
    } finally {
      options.signal?.removeEventListener("abort", abort);
      reader.releaseLock();
    }
    streamMatch = streamPattern.exec(source);
  }
}

/** Stop streamed PDF.js operator execution before a compressed stream can expand without bound. */
export function createPdfOperatorBudget(
  options: { executeOperations?: boolean; maxOperations?: number } = {},
): PdfOperatorBudget {
  const executeOperations = options.executeOperations ?? true;
  const maxOperations = Math.max(
    0,
    Math.floor(
      finitePositive(
        options.maxOperations ?? MAX_PDF_OPERATOR_WORK_PER_PAGE,
        MAX_PDF_OPERATOR_WORK_PER_PAGE,
      ),
    ),
  );
  let consumedOperations = 0;

  return {
    consumedOperations: () => consumedOperations,
    operationsFilter: () => {
      consumedOperations += 1;
      if (consumedOperations > maxOperations) {
        throw new Error("PDF page operation limit exceeded");
      }
      return executeOperations;
    },
  };
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function hasValidPdfViewportDimensions(
  width: number,
  height: number,
): boolean {
  return (
    Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
  );
}

/** Distinguish an intentional blank page from content discarded by PDF.js. */
export function assertPdfPageHasRenderableContent(
  operations: number[],
  probeOperations: number[],
): void {
  if (operations.length === 0 && probeOperations.length > 0) {
    throw new Error("PDF page content was rejected for preview");
  }
}

/** Count-only form used by streamed rendering, which never retains whole operator arrays. */
export function assertPdfPageOperationCounts(
  operations: number,
  probeOperations: number,
): void {
  if (operations === 0 && probeOperations > 0) {
    throw new Error("PDF page content was rejected for preview");
  }
}

/** Bound CSS geometry and backing-store memory for untrusted page dimensions. */
export function calculatePdfCanvasMetrics(
  width: number,
  height: number,
  devicePixelRatio: number,
  maxPixels = MAX_PDF_CANVAS_PIXELS,
): PdfCanvasMetrics {
  const normalizedWidth = finitePositive(width, 1);
  const normalizedHeight = finitePositive(height, 1);
  const cssScale = Math.min(
    1,
    MAX_PDF_CSS_DIMENSION / Math.max(normalizedWidth, normalizedHeight),
  );
  const cssWidth = Math.max(
    1,
    Math.min(MAX_PDF_CSS_DIMENSION, Math.floor(normalizedWidth * cssScale)),
  );
  const cssHeight = Math.max(
    1,
    Math.min(MAX_PDF_CSS_DIMENSION, Math.floor(normalizedHeight * cssScale)),
  );
  const cssPixels = cssWidth * cssHeight;
  const safeMaxPixels = Math.max(
    1,
    Math.min(
      MAX_PDF_CANVAS_PIXELS,
      Math.floor(finitePositive(maxPixels, MAX_PDF_CANVAS_PIXELS)),
    ),
  );
  const desiredOutputScale = Math.min(
    Math.max(finitePositive(devicePixelRatio, 1), 1),
    2,
  );
  const initialOutputScale = Math.min(
    desiredOutputScale,
    MAX_PDF_CANVAS_DIMENSION / cssWidth,
    MAX_PDF_CANVAS_DIMENSION / cssHeight,
    Math.sqrt(safeMaxPixels / cssPixels),
  );
  let pixelWidth = Math.max(
    1,
    Math.min(
      MAX_PDF_CANVAS_DIMENSION,
      safeMaxPixels,
      Math.floor(cssWidth * initialOutputScale),
    ),
  );
  let pixelHeight = Math.max(
    1,
    Math.min(
      MAX_PDF_CANVAS_DIMENSION,
      safeMaxPixels,
      Math.floor(cssHeight * initialOutputScale),
    ),
  );

  if (pixelWidth * pixelHeight > safeMaxPixels) {
    pixelWidth = Math.max(1, Math.floor(safeMaxPixels / pixelHeight));
  }

  const outputScale = Math.min(
    initialOutputScale,
    pixelWidth / cssWidth,
    pixelHeight / cssHeight,
  );
  pixelWidth = Math.max(1, Math.floor(cssWidth * outputScale));
  pixelHeight = Math.max(1, Math.floor(cssHeight * outputScale));

  return {
    cssHeight,
    cssWidth,
    outputScale,
    pageScaleMultiplier: cssScale,
    pixelHeight,
    pixelWidth,
  };
}

/** Convert PDF.js text items into readable page text for assistive technology. */
export function extractPdfPageText(
  items: Array<{ str: string } | { type: string }>,
): string {
  return extractPdfPageTextWithinBudget(items, Number.MAX_SAFE_INTEGER).text;
}

/** Assemble readable text without allocating beyond the supplied character cap. */
export function extractPdfPageTextWithinBudget(
  items: Array<{ str: string } | { type: string }>,
  maxCharacters: number,
): ExtractedPdfPageText {
  const limit = Math.max(0, Math.floor(finitePositive(maxCharacters, 0)));
  let text = "";
  let truncated = false;

  for (const item of items) {
    if (!("str" in item)) continue;
    const word = item.str.trim();
    if (!word) continue;
    const separator = text ? " " : "";
    const remaining = limit - text.length;
    if (remaining <= separator.length) {
      truncated = true;
      break;
    }
    const available = remaining - separator.length;
    text += separator + word.slice(0, available);
    if (word.length > available) {
      truncated = true;
      break;
    }
  }

  return { text, truncated };
}

/** Charge every PDF.js text item before retaining its bounded raw string. */
export function consumePdfTextItemsWithinBudget(
  items: Array<{ str: string } | { type: string }>,
  maxCharacters: number,
  maxItems: number,
): PdfTextBudgetResult {
  const characterLimit = Math.max(
    0,
    Math.floor(finitePositive(maxCharacters, 0)),
  );
  const itemLimit = Math.max(0, Math.floor(finitePositive(maxItems, 0)));
  const accepted: Array<{ str: string }> = [];
  let consumedCharacters = 0;
  let consumedItems = 0;
  let retainedCharacters = 0;

  for (const item of items) {
    if (consumedItems >= itemLimit) {
      return {
        consumedCharacters,
        consumedItems,
        items: accepted,
        retainedCharacters,
        truncated: true,
      };
    }
    consumedItems += 1;
    if (!("str" in item)) continue;

    const remainingCharacters = characterLimit - consumedCharacters;
    if (item.str.length > remainingCharacters) {
      consumedCharacters += item.str.length;
      if (remainingCharacters > 0) {
        accepted.push({ str: item.str.slice(0, remainingCharacters) });
        retainedCharacters += remainingCharacters;
      }
      return {
        consumedCharacters,
        consumedItems,
        items: accepted,
        retainedCharacters,
        truncated: true,
      };
    }
    accepted.push({ str: item.str });
    consumedCharacters += item.str.length;
    retainedCharacters += item.str.length;
  }

  return {
    consumedCharacters,
    consumedItems,
    items: accepted,
    retainedCharacters,
    truncated: false,
  };
}
