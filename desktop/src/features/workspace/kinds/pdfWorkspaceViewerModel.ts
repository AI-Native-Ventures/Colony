const MIN_PDF_SCALE = 0.5;
const MAX_PDF_SCALE = 2.5;
export const MAX_PDF_CANVAS_PIXELS = 4_000_000;
export const MAX_PDF_CANVAS_DIMENSION = 8_192;
export const MAX_PDF_CSS_DIMENSION = 8_192;
export const MAX_PDF_IMAGE_PIXELS = 16_000_000;
export const MAX_PDF_CANVAS_AREA_BYTES = 64 * 1_024 * 1_024;
export const MAX_PDF_WORKSPACE_PAGES = 500;
export const MAX_PDF_OPERATOR_WORK_PER_PAGE = 100_000;
export const MAX_PDF_TEXT_CHARS_PER_PAGE = 200_000;
export const MAX_PDF_TEXT_CHARS_TOTAL = 2_000_000;
export const MAX_PDF_TEXT_ITEMS_PER_PAGE = 50_000;
export const MAX_PDF_TEXT_ITEMS_TOTAL = 500_000;

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
