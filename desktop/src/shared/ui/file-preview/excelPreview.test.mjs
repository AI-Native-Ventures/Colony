import assert from "node:assert/strict";
import { test } from "node:test";
import * as XLSX from "xlsx";
import { zipSync, strToU8 } from "fflate";
import { parseExcelPreview } from "./excelPreview.ts";
import { assertSpreadsheetArchiveBudget } from "./spreadsheetArchiveBudget.ts";

test("Excel preview reads real sheets, formatted saved values and marks uncached formulas", () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Item", "Amount"],
    ["Retainer", 1250],
    ["Total", 2500],
    ["Uncalculated", null],
  ]);
  sheet.B2.z = '"R" #,##0.00';
  sheet.B3 = { t: "n", v: 2500, f: "SUM(B2:B2)*2" };
  sheet.B4 = { t: "n", f: "SUM(B2:B3)" };
  XLSX.utils.book_append_sheet(workbook, sheet, "Budget");
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["Literal HTML"], ["<script>alert(1)</script>"]]),
    "Notes",
  );
  const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  const result = parseExcelPreview(new Uint8Array(bytes));
  assert.equal(result.sheets.length, 2);
  assert.equal(result.sheets[0].name, "Budget");
  assert.equal(result.sheets[0].rows[1][1].text, "R 1,250.00");
  assert.equal(result.sheets[0].rows[2][1].text, "2500");
  assert.equal(result.sheets[0].rows[3][1].unavailable, true);
  assert.equal(result.sheets[1].rows[1][0].text, "<script>alert(1)</script>");
  assert.equal(result.formulaValues, true);
});

test("Excel preview detects row truncation from the original worksheet range", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(
      Array.from({ length: 1010 }, (_, i) => [i, `row ${i}`]),
    ),
    "Long",
  );
  const result = parseExcelPreview(
    new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" })),
  );
  assert.equal(result.sheets[0].rows.length, 1000);
  assert.equal(result.sheets[0].totalRows, 1010);
  assert.equal(result.truncated, true);
});

test("archive preflight rejects entry floods and incomplete archives", () => {
  const entries = Object.fromEntries(
    Array.from({ length: 257 }, (_, index) => [`entry-${index}`, strToU8("x")]),
  );
  assert.throws(
    () => assertSpreadsheetArchiveBudget(zipSync(entries)),
    /complex/,
  );
  assert.throws(
    () => assertSpreadsheetArchiveBudget(new Uint8Array([0x50, 0x4b, 0, 0])),
    /incomplete/,
  );
});
