import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  columnLabel,
  TABLE_PAGE_SIZE,
  type PreviewWorkbook,
} from "./filePreviewModel";

/** Controlled navigation persists when the same document expands or collapses. */
export type SpreadsheetFilePreviewProps = {
  workbook: PreviewWorkbook;
  sheetIndex: number;
  rowPage: number;
  onSheetChange: (index: number) => void;
  onRowPageChange: (page: number) => void;
};

/** A literal, read-only table of source values with bounded rows and sheet navigation. */
export function SpreadsheetFilePreview({
  workbook,
  sheetIndex,
  rowPage,
  onSheetChange,
  onRowPageChange,
}: SpreadsheetFilePreviewProps) {
  const sheet = workbook.sheets[sheetIndex];
  if (!sheet)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        This workbook has no previewable sheets.
      </p>
    );
  const page = Math.min(
    rowPage,
    Math.max(0, Math.ceil(sheet.rows.length / TABLE_PAGE_SIZE) - 1),
  );
  const start = page * TABLE_PAGE_SIZE;
  const rows = sheet.rows
    .slice(start, start + TABLE_PAGE_SIZE)
    .map((cells, offset) => ({
      cells,
      sourceRow: sheet.firstRow + start + offset,
    }));
  const columns = Math.max(1, ...rows.map((row) => row.cells.length));
  return (
    <div data-testid="spreadsheet-file-preview" className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          Sheet
          <select
            aria-label="Worksheet"
            value={sheetIndex}
            onChange={(event) => onSheetChange(Number(event.target.value))}
            className="min-w-0 max-w-48 rounded-md border border-border bg-background px-2 py-1 text-foreground"
          >
            {workbook.sheets.map((item, index) => (
              <option key={item.name} value={index}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-muted-foreground">
          {sheet.totalRows.toLocaleString()} rows ·{" "}
          {sheet.totalColumns.toLocaleString()} columns
        </span>
      </div>
      <section
        className="max-h-[28rem] overflow-auto overscroll-contain"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: A bounded scroll region must support keyboard scrolling.
        tabIndex={0}
        aria-label={`${sheet.name} read-only values`}
      >
        <table
          className="w-full border-collapse text-left text-sm"
          data-testid="file-preview-table"
        >
          <caption className="sr-only">
            {sheet.name}. Read-only data preview. Row numbers and column letters
            refer to the original sheet.
          </caption>
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              <th
                scope="col"
                className="border-b border-r border-border px-2 py-2 text-xs text-muted-foreground"
              >
                Row
              </th>
              {Array.from({ length: columns }, (_, index) => (
                <th
                  scope="col"
                  key={columnLabel(sheet.firstColumn + index)}
                  className="min-w-32 border-b border-r border-border px-3 py-2 font-medium"
                >
                  {columnLabel(sheet.firstColumn + index)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ cells: row, sourceRow }) => (
              <tr key={sourceRow} className="even:bg-muted/25">
                <th
                  scope="row"
                  className="border-b border-r border-border bg-muted/30 px-2 py-2 text-xs font-normal tabular-nums text-muted-foreground"
                >
                  {sourceRow + 1}
                </th>
                {Array.from({ length: columns }, (_, cellIndex) => (
                  <td
                    key={columnLabel(cellIndex)}
                    className="max-w-80 whitespace-pre-wrap break-words border-b border-r border-border px-3 py-2 align-top"
                    title={
                      row[cellIndex]?.unavailable
                        ? "The original workbook did not save a calculated result. Open it in a spreadsheet app to calculate."
                        : undefined
                    }
                  >
                    {row[cellIndex]?.unavailable ? (
                      <span className="text-xs text-muted-foreground">
                        {row[cellIndex].text}
                      </span>
                    ) : (
                      row[cellIndex]?.text || ""
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <p className="p-4 text-sm text-muted-foreground">
            {sheet.truncated
              ? "This sheet's values are beyond the preview row limit. Download the original to view them."
              : "This sheet is empty."}
          </p>
        )}
      </section>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <span>
          Rows {rows.length ? sheet.firstRow + start + 1 : 0}–
          {rows.length ? sheet.firstRow + start + rows.length : 0}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous rows"
            disabled={page === 0}
            onClick={() => onRowPageChange(page - 1)}
            className="rounded-md border border-border p-1.5 disabled:opacity-40"
          >
            <ChevronLeft className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Next rows"
            disabled={start + rows.length >= sheet.rows.length}
            onClick={() => onRowPageChange(page + 1)}
            className="rounded-md border border-border p-1.5 disabled:opacity-40"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>
      {(workbook.truncated || workbook.formulaValues) && (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {workbook.truncated
            ? `Partial preview: at most 20 sheets, the first 1,000 source rows per sheet, 40 columns and 2,000 characters per cell. ${workbook.totalSheets} source sheets. `
            : ""}
          {workbook.formulaValues
            ? "Formulas show saved results; this preview does not recalculate."
            : ""}
        </p>
      )}
    </div>
  );
}
