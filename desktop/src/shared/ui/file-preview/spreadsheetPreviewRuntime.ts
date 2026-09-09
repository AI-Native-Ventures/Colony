import type { PreviewWorkbook } from "./filePreviewModel";

/** Parse in a disposable worker so malformed workbooks cannot block conversation input. */
export function parseSpreadsheetInWorker(
  bytes: Uint8Array<ArrayBuffer>,
  format: "csv" | "excel",
  filename: string,
  signal: AbortSignal,
): Promise<PreviewWorkbook> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./spreadsheetPreview.worker.ts", import.meta.url),
      { type: "module" },
    );
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      finish();
      reject(new Error("Preview cancelled"));
    };
    const timer = setTimeout(() => {
      finish();
      reject(
        new Error(
          "This workbook took too long to preview. Download the original.",
        ),
      );
    }, 8000);
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (
      event: MessageEvent<{ workbook?: PreviewWorkbook; error?: string }>,
    ) => {
      finish();
      if (event.data.workbook) resolve(event.data.workbook);
      else
        reject(
          new Error(event.data.error || "Spreadsheet preview unavailable"),
        );
    };
    worker.onerror = () => {
      finish();
      reject(new Error("Spreadsheet preview unavailable"));
    };
    const copy = bytes.slice();
    worker.postMessage({ bytes: copy, format, filename }, [copy.buffer]);
  });
}
