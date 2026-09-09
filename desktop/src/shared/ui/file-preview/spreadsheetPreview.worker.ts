import { parseCsvPreview } from "./csvPreview";
import { parseExcelPreview } from "./excelPreview";
import { assertFilePreviewSize } from "./filePreviewModel";

self.onmessage = (
  event: MessageEvent<{
    bytes: Uint8Array;
    format: "csv" | "excel";
    filename: string;
  }>,
) => {
  try {
    const { bytes, format, filename } = event.data;
    assertFilePreviewSize(bytes.byteLength);
    const workbook =
      format === "csv"
        ? parseCsvPreview(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            /\.tsv$/i.test(filename) ? "\t" : ",",
          )
        : parseExcelPreview(bytes);
    self.postMessage({ workbook });
  } catch {
    self.postMessage({
      error:
        "This spreadsheet could not be previewed within the supported limits. Download the original to inspect it.",
    });
  }
};
