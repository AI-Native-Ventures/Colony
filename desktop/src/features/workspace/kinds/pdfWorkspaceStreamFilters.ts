export type PdfFilterName =
  | "ASCII85Decode"
  | "ASCIIHexDecode"
  | "CCITTFaxDecode"
  | "DCTDecode"
  | "FlateDecode"
  | "JBIG2Decode"
  | "JPXDecode"
  | "LZWDecode"
  | "RunLengthDecode";

const FILTER_ALIASES = new Map<string, PdfFilterName>([
  ["A85", "ASCII85Decode"],
  ["AHx", "ASCIIHexDecode"],
  ["ASCII85Decode", "ASCII85Decode"],
  ["ASCIIHexDecode", "ASCIIHexDecode"],
  ["CCF", "CCITTFaxDecode"],
  ["CCITTFaxDecode", "CCITTFaxDecode"],
  ["DCT", "DCTDecode"],
  ["DCTDecode", "DCTDecode"],
  ["Fl", "FlateDecode"],
  ["FlateDecode", "FlateDecode"],
  ["JBIG2Decode", "JBIG2Decode"],
  ["JPX", "JPXDecode"],
  ["JPXDecode", "JPXDecode"],
  ["LZW", "LZWDecode"],
  ["LZWDecode", "LZWDecode"],
  ["RL", "RunLengthDecode"],
  ["RunLengthDecode", "RunLengthDecode"],
]);

const IMAGE_FILTERS = new Set<PdfFilterName>([
  "CCITTFaxDecode",
  "DCTDecode",
  "JBIG2Decode",
  "JPXDecode",
]);

export function normalizePdfFilterName(name: string): PdfFilterName | null {
  return FILTER_ALIASES.get(name) ?? null;
}

export function validatePdfFilterOrder(
  filters: PdfFilterName[],
  isImageStream: boolean,
): void {
  if (filters.length === 0) return;
  const finalFilter = filters.at(-1);
  const prefix = filters.slice(0, -1);
  if (
    prefix.some(
      (filter) => filter !== "ASCII85Decode" && filter !== "ASCIIHexDecode",
    )
  ) {
    throw new Error("unsupported PDF stream filter chain");
  }
  if (
    finalFilter !== "ASCII85Decode" &&
    finalFilter !== "ASCIIHexDecode" &&
    finalFilter !== "FlateDecode" &&
    finalFilter !== "LZWDecode" &&
    finalFilter !== "RunLengthDecode" &&
    !(isImageStream && finalFilter && IMAGE_FILTERS.has(finalFilter))
  ) {
    throw new Error("unsupported PDF stream filter chain");
  }
}
