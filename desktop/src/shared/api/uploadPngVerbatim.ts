/**
 * Upload a PNG this app rendered, byte for byte.
 *
 * Its own module rather than a function in `tauri.ts` because that file sits
 * at the file-size ratchet's limit and may not grow.
 */

import { invokeTauri, type BlobDescriptor } from "@/shared/api/tauri";

/**
 * Upload `data` exactly as given, with no re-encode.
 *
 * `uploadMediaBytes` strips image metadata by decoding and encoding again,
 * which changes every byte. The content renderer measures a card's pixels and
 * binds a gate report to the hash of those bytes, so it has to upload the
 * exact bytes it measured or the report names a blob the relay never stored.
 * Nothing needs stripping here: the PNG comes from the app's own canvas, not
 * a camera. The Rust side accepts PNG only.
 */
export async function uploadPngVerbatim(
  data: number[],
  filename?: string,
): Promise<BlobDescriptor> {
  return invokeTauri<BlobDescriptor>("upload_png_verbatim", {
    data,
    filename,
  });
}
