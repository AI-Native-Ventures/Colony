const MIN_PDF_SCALE = 0.5;
const MAX_PDF_SCALE = 2.5;
export const MAX_PDF_CANVAS_PIXELS = 4_000_000;
export const MAX_PDF_CANVAS_DIMENSION = 8_192;
export const MAX_PDF_CSS_DIMENSION = 8_192;
export const MAX_PDF_IMAGE_PIXELS = MAX_PDF_CANVAS_PIXELS;
export const MAX_PDF_CANVAS_AREA_BYTES = MAX_PDF_CANVAS_PIXELS * 4;
export const MAX_PDF_WORKSPACE_PAGES = 500;
export const MAX_PDF_TEXT_CHARS_PER_PAGE = 200_000;
export const MAX_PDF_TEXT_CHARS_TOTAL = 2_000_000;

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
