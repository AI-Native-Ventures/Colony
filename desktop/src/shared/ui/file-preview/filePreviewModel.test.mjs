import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertFilePreviewSize,
  classifyFilePreviewUrl,
  columnLabel,
  filePreviewKind,
  MAX_FILE_PREVIEW_BYTES,
} from "./filePreviewModel.ts";
import { parseCsvPreview } from "./csvPreview.ts";

test("file preview rejects executable URLs, credentials and traversal but admits explicit fixture paths", () => {
  for (const url of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>",
    "https://user:secret@relay.example/media/a.pdf",
    "/rich-previews/../private.pdf",
    "/rich-previews/%2e%2e/private.pdf",
    "//attacker.example/x.pdf",
    "/private.pdf",
  ])
    assert.equal(classifyFilePreviewUrl(url), null, url);
  assert.equal(classifyFilePreviewUrl("/rich-previews/budget.xlsx"), "bundled");
  assert.equal(
    classifyFilePreviewUrl("https://relay.example/media/a.pdf"),
    "media",
  );
});

test("preview bounds reject untrusted sizes and HTML does not become a PDF", () => {
  assert.doesNotThrow(() => assertFilePreviewSize(MAX_FILE_PREVIEW_BYTES));
  for (const size of [-1, NaN, Infinity, MAX_FILE_PREVIEW_BYTES + 1])
    assert.throws(() => assertFilePreviewSize(size));
  assert.equal(filePreviewKind("tricky.pdf", "text/html"), "unsupported");
  assert.equal(
    filePreviewKind("budget.XLSX", "application/octet-stream"),
    "excel",
  );
  assert.equal(filePreviewKind("report.pdf", "application/pdf"), "pdf");
  assert.equal(filePreviewKind("data.tsv"), "csv");
  assert.equal(columnLabel(26), "AA");
  assert.equal(columnLabel(39), "AN");
});

test("CSV retains quoted delimiters, multiline fields, escaped quotes, BOM and original text", () => {
  const preview = parseCsvPreview(
    '\uFEFFAccount,Note,Value\r\n"Acme, Ltd","First\nsecond ""line""",0012\r\nBob,=SUM(A1:A2),<img src=x onerror=alert(1)>\r\n',
  );
  const rows = preview.sheets[0].rows.map((row) =>
    row.map((cell) => cell.text),
  );
  assert.deepEqual(rows, [
    ["Account", "Note", "Value"],
    ["Acme, Ltd", 'First\nsecond "line"', "0012"],
    ["Bob", "=SUM(A1:A2)", "<img src=x onerror=alert(1)>"],
  ]);
  assert.equal(preview.sheets[0].totalRows, 3);
  assert.equal(preview.truncated, false);
});

test("CSV reports bounded rows, columns and long values without pretending subset is complete", () => {
  const wide = Array.from({ length: 45 }, (_, i) => String(i)).join(",");
  const text = [
    wide,
    ...Array.from({ length: 1002 }, () => `"${"x".repeat(2001)}",value`),
  ].join("\n");
  const sheet = parseCsvPreview(text).sheets[0];
  assert.equal(sheet.rows.length, 1000);
  assert.equal(sheet.rows[0].length, 40);
  assert.equal(sheet.rows[1][0].text.length, 2000);
  assert.equal(sheet.totalRows, 1003);
  assert.equal(sheet.totalColumns, 45);
  assert.equal(sheet.truncated, true);
});

test("CSV preserves empty trailing cells and rejects unfinished quotes", () => {
  assert.deepEqual(
    parseCsvPreview("a,b,\nc,d,").sheets[0].rows.map((r) =>
      r.map((c) => c.text),
    ),
    [
      ["a", "b", ""],
      ["c", "d", ""],
    ],
  );
  assert.equal(parseCsvPreview("").sheets[0].totalRows, 0);
  assert.throws(() => parseCsvPreview('name,"unfinished'));
  assert.throws(() => parseCsvPreview('name,"closed"extra'));
});
