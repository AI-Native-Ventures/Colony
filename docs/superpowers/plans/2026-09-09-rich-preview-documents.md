# Read-only document previews in conversations

## Acceptance gate

CSV, Excel and PDF attachments render their actual bytes inside channels, threads and the Blocks catalog using the same component. Page, sheet and row position survive expansion. The original stays downloadable without reconstruction. Unsupported, failed, encrypted and oversized files explain the limit. No editing, formulas, highlights or annotations are introduced.

Local work is restricted to quick targeted checks. The user explicitly forbids `just ci`, broad suites, builds and Cargo compilation on this Mac. Browser and full integration checks run in GitHub CI under the coordinator.

## Implementation

1. Add a shared `InlineFilePreview` shell with lazy load on visibility, cancellation/stale-response guards, themed metadata, original download and Radix expansion. Sources use existing validated media IPC or containment-checked workspace path resolution; only bundled `/rich-previews/` assets use bounded same-origin fetch. No external credentialed browser fetching.
2. Extract the existing PDF.js runtime and safety models to shared document code; leave compatibility exports for current workspace viewers. Load one page at a time, retain page/zoom on expansion, and reuse existing canvas/text/decoded-stream limits. Canvas and accessible text are read-only; document actions and embedded links are never executed.
3. Parse CSV and Excel off the UI thread. Input is capped at 8 MiB; XLSX ZIP expansion is streamed and capped at 32 MiB before parsing. Limit preview sheets, rows, columns and cell characters and identify every partial view. Render plain text values through React. Formula cells use saved values and explicitly label unavailable values.
4. Route supported Markdown FileCards through the shared component while preserving unsupported-file open/download actions. Expose the same export to the Blocks renderer and catalog. Workspace/local callers pass an explicit local path rather than allowing arbitrary URL-to-file conversion.
5. Add focused parser/bounds/source-policy regression tests and CI browser coverage for actual CSV/XLSX/PDF files, navigation, expansion, downloads and failure states.

## Dependencies and evidence

Use the existing PDF.js dependency. Add SheetJS CE 0.20.3 from the official tarball endpoint, not the stale npm registry build, and fflate 0.8.2 for bounded streamed ZIP preflight. Package/lock edits belong to the coordinator.

- https://docs.sheetjs.com/docs/getting-started/installation/nodejs/ (official tarball and registry status)
- https://docs.sheetjs.com/docs/api/parse-options/ (`sheetRows`, sheet selection, formula and formatted-cell fields)
- https://docs.sheetjs.com/docs/csf/cell/ (cached values and formula metadata)
- https://github.com/101arrowz/fflate (streamed unzip API)

## Proof boundaries

Focused local tests establish parser and source-policy behaviour. CI browser tests establish the actual renderer with synthetic transport/files. No hosted download, packaged Electron/Tauri operation or live customer files are claimed without a separate observed run.

## Implementation checkpoint

- Shared document renderer, original downloads, controlled sheet/row/page/zoom expansion and size-preserving inline placeholder are implemented. Excel/CSV parse in a cancellable worker; the PDF safety runtime is shared with the existing workspace viewer through compatibility exports.
- Actual bundled fixtures are `service-ledger.csv` (1,366 bytes), `service-ledger.xlsx` (11,441 bytes, Revenue and Summary), and `service-report.pdf` (1,282 bytes, two pages).
- 13 targeted parser/source/load tests and 6 selected existing PDF/FileBody compatibility tests pass locally. Scoped Biome and TypeScript transpile syntax checks pass. Native content-policy regression uses the same fixture bytes and is reserved for CI.
- Blocks review corrected missing filename inference for bare PDF/spreadsheet URLs, with a failing-before/passing-after regression. Nine related Blocks/schema/catalog tests pass.
- `rich-document-previews.spec.ts` covers real bytes, original-download hashes, expansion/navigation, unavailable/oversized source boundaries through focused tests, narrow layout, and message/thread attachment integration. Screenshot capture is wired to CI artifact paths with animation waits. Browser execution, native test execution, and packaged validation remain unproven.
