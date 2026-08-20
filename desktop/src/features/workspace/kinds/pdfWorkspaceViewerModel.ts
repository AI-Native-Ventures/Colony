const MIN_PDF_SCALE = 0.5;
const MAX_PDF_SCALE = 2.5;
export const MAX_PDF_CANVAS_PIXELS = 4_000_000;
export const MAX_PDF_WORKSPACE_PAGES = 500;

export type PdfCanvasMetrics = {
  cssHeight: number;
  cssWidth: number;
  outputScale: number;
  pixelHeight: number;
  pixelWidth: number;
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

/** Bound backing-store memory while preserving the requested CSS page size. */
export function calculatePdfCanvasMetrics(
  width: number,
  height: number,
  devicePixelRatio: number,
  maxPixels = MAX_PDF_CANVAS_PIXELS,
): PdfCanvasMetrics {
  const cssWidth = Math.max(1, Math.floor(width));
  const cssHeight = Math.max(1, Math.floor(height));
  const cssPixels = cssWidth * cssHeight;
  const desiredOutputScale = Math.min(Math.max(devicePixelRatio || 1, 1), 2);
  const outputScale = Math.min(
    desiredOutputScale,
    Math.sqrt(maxPixels / cssPixels),
  );
  const pixelWidth = Math.max(1, Math.floor(cssWidth * outputScale));
  const pixelHeight = Math.max(1, Math.floor(cssHeight * outputScale));

  return {
    cssHeight,
    cssWidth,
    outputScale,
    pixelHeight,
    pixelWidth,
  };
}

/** Convert PDF.js text items into readable page text for assistive technology. */
export function extractPdfPageText(
  items: Array<{ str: string } | { type: string }>,
): string {
  return items
    .map((item) => ("str" in item ? item.str.trim() : ""))
    .filter(Boolean)
    .join(" ");
}
