const MIN_PDF_SCALE = 0.5;
const MAX_PDF_SCALE = 2.5;

/** Keep workspace PDF zoom inside the supported 50% to 250% range. */
export function clampPdfScale(value: number): number {
  return Math.min(MAX_PDF_SCALE, Math.max(MIN_PDF_SCALE, value));
}

/** Decode the raw base64 payload supplied by the workspace file loader. */
export function decodePdfBytes(bytesBase64: string): Uint8Array {
  const binary = globalThis.atob(bytesBase64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
