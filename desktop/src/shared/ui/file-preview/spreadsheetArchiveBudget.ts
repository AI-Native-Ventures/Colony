import { Unzip, UnzipInflate } from "fflate";

const MAX_DECODED_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 256;

/** Inspect actual streamed ZIP output before handing XLSX/XLSB bytes to a parser. */
export function assertSpreadsheetArchiveBudget(bytes: Uint8Array): void {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return; // Legacy XLS is not a ZIP.
  let total = 0,
    count = 0,
    pending = 0;
  const names = new Set<string>();
  const unzip = new Unzip((file) => {
    count++;
    pending++;
    if (count > MAX_ARCHIVE_ENTRIES || names.has(file.name))
      throw new Error("The workbook archive is too complex to preview.");
    names.add(file.name);
    if ((file.originalSize ?? 0) > MAX_DECODED_BYTES)
      throw new Error("The expanded workbook exceeds the preview limit.");
    file.ondata = (error, data, final) => {
      if (error) throw error;
      total += data.byteLength;
      if (total > MAX_DECODED_BYTES) {
        file.terminate();
        throw new Error("The expanded workbook exceeds the preview limit.");
      }
      if (final) pending--;
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    unzip.push(
      bytes.subarray(offset, offset + 1024),
      offset + 1024 >= bytes.length,
    );
  }
  if (!count || pending) throw new Error("The workbook archive is incomplete.");
}
