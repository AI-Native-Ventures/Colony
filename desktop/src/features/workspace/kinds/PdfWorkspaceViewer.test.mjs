import assert from "node:assert/strict";
import test from "node:test";

const { clampPdfScale, decodePdfBytes } = await import(
  "./pdfWorkspaceViewerModel.ts"
);

test("PDF scale stays inside the supported range", () => {
  assert.equal(clampPdfScale(0.2), 0.5);
  assert.equal(clampPdfScale(1.25), 1.25);
  assert.equal(clampPdfScale(4), 2.5);
});

test("base64 PDF bytes decode without a data URL", () => {
  const bytes = decodePdfBytes(globalThis.btoa("%PDF-1.4"));
  assert.equal(new TextDecoder().decode(bytes), "%PDF-1.4");
});
