import { invokeTauri } from "@/shared/api/tauri";

export type FetchBlockDataRequest = {
  url: string;
  mime: string;
  sha256: string;
  byteSize: number;
};

/**
 * Fetch content-addressed public Block JSON through the native SSRF boundary.
 * The command returns only bytes whose destination, size, digest, UTF-8, and
 * JSON shape have already been checked.
 */
export async function fetchBlockData(
  request: FetchBlockDataRequest,
): Promise<Uint8Array> {
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.hostname.length === 0) {
    throw new Error("External Block data must use HTTPS.");
  }
  const bytes = await invokeTauri<number[]>("fetch_block_data", request);
  return Uint8Array.from(bytes);
}
