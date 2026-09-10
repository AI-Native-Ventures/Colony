/** Shared preview bounds; original downloads remain separate from parsing. */
export const MAX_FILE_PREVIEW_BYTES = 8 * 1024 * 1024;
export const MAX_PREVIEW_ROWS = 1000;
export const MAX_PREVIEW_COLUMNS = 40;
export const MAX_PREVIEW_SHEETS = 20;
export const MAX_PREVIEW_CELL_CHARACTERS = 2000;
export const TABLE_PAGE_SIZE = 25;

/** Document formats with a read-only inline renderer. */
export type FilePreviewKind = "pdf" | "csv" | "excel" | "unsupported";

/** A plain-text cell; formula content is never executed or rendered as HTML. */
export type PreviewCell = { text: string; unavailable?: boolean };
/** One bounded worksheet, retaining source row and column coordinates. */
export type PreviewSheet = {
  name: string;
  rows: PreviewCell[][];
  firstRow: number;
  firstColumn: number;
  totalRows: number;
  totalColumns: number;
  truncated: boolean;
};
/** A parsed data-only workbook, safe to cross the worker boundary. */
export type PreviewWorkbook = {
  sheets: PreviewSheet[];
  totalSheets: number;
  truncated: boolean;
  formulaValues: boolean;
};

/** Select by known MIME/extension; HTML never becomes an active document. */
export function filePreviewKind(filename: string, mime = ""): FilePreviewKind {
  const type = mime.toLowerCase().split(";")[0].trim();
  if (type === "text/html" || type === "application/xhtml+xml")
    return "unsupported";
  const extension = filename.toLowerCase().split(".").pop();
  if (type === "application/pdf" || extension === "pdf") return "pdf";
  if (type === "text/csv" || extension === "csv" || extension === "tsv")
    return "csv";
  if (
    extension === "xlsx" ||
    extension === "xls" ||
    extension === "xlsb" ||
    type === "application/vnd.ms-excel" ||
    type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
    return "excel";
  return "unsupported";
}

/** Whether the shared file preview can interpret this attachment. */
export function supportsInlineFilePreview(
  filename: string,
  mime = "",
): boolean {
  return filePreviewKind(filename, mime) !== "unsupported";
}

/** Accept absolute HTTP media and an explicit namespace of shipped examples. */
export function classifyFilePreviewUrl(
  href: string,
): "bundled" | "media" | null {
  if (
    /^\/rich-previews\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(href) &&
    !href.split("/").some((part) => part === ".." || part === ".")
  )
    return "bundled";
  try {
    const url = new URL(href);
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    )
      return "media";
  } catch {
    /* A message-supplied path is not a URL attachment. */
  }
  return null;
}

/** Keep preview size checks independent of untrusted metadata. */
export function assertFilePreviewSize(bytes: number): void {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > MAX_FILE_PREVIEW_BYTES
  ) {
    throw new Error(
      "This file exceeds the 8 MB preview limit. Download the original to view it.",
    );
  }
}

/** Excel-like column labels without assuming the first row is a heading. */
export function columnLabel(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}
