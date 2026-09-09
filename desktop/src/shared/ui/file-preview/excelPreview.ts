import * as XLSX from "xlsx";
import { assertSpreadsheetArchiveBudget } from "./spreadsheetArchiveBudget";
import {
  assertFilePreviewSize,
  MAX_PREVIEW_CELL_CHARACTERS,
  MAX_PREVIEW_COLUMNS,
  MAX_PREVIEW_ROWS,
  MAX_PREVIEW_SHEETS,
  type PreviewCell,
  type PreviewSheet,
  type PreviewWorkbook,
} from "./filePreviewModel";

/** Parse saved Excel values only; macros, hyperlinks, rich HTML and formulas are not run. */
export function parseExcelPreview(bytes: Uint8Array): PreviewWorkbook {
  assertFilePreviewSize(bytes.byteLength);
  assertSpreadsheetArchiveBudget(bytes);
  const metadata = XLSX.read(bytes, { type: "array", bookSheets: true });
  const names = metadata.SheetNames.slice(0, MAX_PREVIEW_SHEETS);
  const book = XLSX.read(bytes, {
    type: "array",
    sheets: names,
    sheetRows: MAX_PREVIEW_ROWS,
    dense: false,
    cellFormula: true,
    cellHTML: false,
    cellStyles: false,
    bookVBA: false,
    sheetStubs: true,
    WTF: true,
  });
  let formulaValues = false;
  const sheets: PreviewSheet[] = names.map((name) => {
    const sheet = book.Sheets[name];
    if (!sheet) throw new Error("A worksheet could not be read.");
    const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
    const full = XLSX.utils.decode_range(
      sheet["!fullref"] || sheet["!ref"] || "A1",
    );
    const lastRow = Math.min(range.e.r, range.s.r + MAX_PREVIEW_ROWS - 1);
    const lastColumn = Math.min(range.e.c, range.s.c + MAX_PREVIEW_COLUMNS - 1);
    let truncated = lastRow < full.e.r || lastColumn < full.e.c;
    const rows: PreviewCell[][] = [];
    for (let r = range.s.r; r <= lastRow; r++) {
      const row: PreviewCell[] = [];
      for (let c = range.s.c; c <= lastColumn; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })] as
          | XLSX.CellObject
          | undefined;
        if (cell?.f) formulaValues = true;
        const unavailable = Boolean(
          cell?.f &&
            (cell.v === undefined || cell.v === null || cell.t === "z"),
        );
        const raw = unavailable
          ? "Calculated value unavailable"
          : (cell?.w ?? (cell?.v == null ? "" : String(cell.v)));
        if (raw.length > MAX_PREVIEW_CELL_CHARACTERS) truncated = true;
        row.push({
          text: raw.slice(0, MAX_PREVIEW_CELL_CHARACTERS),
          ...(unavailable ? { unavailable: true } : {}),
        });
      }
      rows.push(row);
    }
    return {
      name,
      rows,
      firstRow: range.s.r,
      firstColumn: range.s.c,
      totalRows: full.e.r - full.s.r + 1,
      totalColumns: full.e.c - full.s.c + 1,
      truncated,
    };
  });
  return {
    sheets,
    totalSheets: metadata.SheetNames.length,
    truncated:
      metadata.SheetNames.length > names.length ||
      sheets.some((s) => s.truncated),
    formulaValues,
  };
}
