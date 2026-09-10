import {
  MAX_PREVIEW_CELL_CHARACTERS,
  MAX_PREVIEW_COLUMNS,
  MAX_PREVIEW_ROWS,
  type PreviewWorkbook,
} from "./filePreviewModel";

/** Parse quoted CSV/TSV as literal text, including BOM, CRLF and embedded newlines. */
export function parseCsvPreview(
  text: string,
  delimiter = ",",
): PreviewWorkbook {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    afterQuote = false;
  let totalRows = 0,
    totalColumns = 0,
    clipped = false;
  const pushField = () => {
    if (row.length < MAX_PREVIEW_COLUMNS) row.push(field);
    else clipped = true;
    field = "";
    afterQuote = false;
  };
  let columns = 0;
  const finishRow = () => {
    pushField();
    columns++;
    totalColumns = Math.max(totalColumns, columns);
    totalRows++;
    if (rows.length < MAX_PREVIEW_ROWS) rows.push(row);
    else clipped = true;
    row = [];
    columns = 0;
  };
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          if (field.length < MAX_PREVIEW_CELL_CHARACTERS) field += '"';
          else clipped = true;
          i++;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else if (field.length < MAX_PREVIEW_CELL_CHARACTERS) field += char;
      else clipped = true;
    } else if (char === '"' && !field && !afterQuote) quoted = true;
    else if (char === delimiter) {
      pushField();
      columns++;
    } else if (char === "\n" || char === "\r") {
      finishRow();
      if (char === "\r" && source[i + 1] === "\n") i++;
    } else if (afterQuote) {
      throw new Error(
        "The CSV has invalid quoted fields. Download the original to inspect it.",
      );
    } else if (field.length < MAX_PREVIEW_CELL_CHARACTERS) field += char;
    else clipped = true;
  }
  if (quoted)
    throw new Error(
      "The CSV has an unfinished quoted field. Download the original to inspect it.",
    );
  if (field || row.length || source.endsWith(delimiter) || afterQuote)
    finishRow();
  return {
    sheets: [
      {
        name: "Data",
        rows: rows.map((values) => values.map((value) => ({ text: value }))),
        firstRow: 0,
        firstColumn: 0,
        totalRows,
        totalColumns,
        truncated: clipped,
      },
    ],
    totalSheets: 1,
    truncated: clipped,
    formulaValues: false,
  };
}
