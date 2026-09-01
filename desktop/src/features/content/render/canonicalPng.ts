/**
 * Strip the PNG chunks the relay refuses.
 *
 * The relay validates every uploaded PNG against a chunk allowlist
 * (`validate_png_metadata_free` in `buzz-media/src/validation.rs`) and answers
 * 422 "media contains metadata or a non-canonical metadata channel" for
 * anything outside it.
 *
 * WebKit's canvas encoder writes an `eXIf` chunk, which is on that forbidden
 * list, so a card straight out of `toBlob` is refused. Probed in both engines
 * rather than guessed:
 *
 * ```text
 * WEBKIT    IHDR, sRGB, eXIf(68), IDAT, IEND
 * CHROMIUM  IHDR, IDAT, IDAT, IEND
 * ```
 *
 * Chromium emits nothing forbidden, which is why no Chromium test would ever
 * have found this. The app runs on WKWebView.
 *
 * The desktop's ordinary upload path solves this by decoding and re-encoding
 * the image, which is fine for a file a person picked and useless here: the
 * content renderer binds a gate report to the hash of the bytes it measured,
 * so the bytes that reach the relay have to be the bytes that were hashed.
 *
 * So this edits the container instead of the image. Chunks are copied or
 * dropped whole and `IDAT` is never touched, which means the pixels are bit
 * for bit what was measured -- the same reason the re-encode was safe to look
 * at and unsafe to hash.
 */

/**
 * Ancillary chunks the relay keeps, mirroring its `known_rendering` list.
 *
 * `pHYs` is absent on purpose at both ends: arbitrary values in it are an
 * identity channel, so the relay treats it as metadata even though it affects
 * display.
 */
const KEPT_ANCILLARY = new Set([
  "cHRM",
  "gAMA",
  "sBIT",
  "sRGB",
  "bKGD",
  "hIST",
  "tRNS",
  "sPLT",
  "acTL",
  "fcTL",
  "fdAT",
]);

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A chunk's type is ancillary when the first byte is lowercase (bit 5 set). */
function isAncillary(kind: string): boolean {
  return (kind.charCodeAt(0) & 0x20) !== 0;
}

/**
 * Return `bytes` with every chunk the relay forbids removed.
 *
 * Throws on input that is not a PNG this can reason about, rather than
 * returning it unchanged: a silent pass-through would surface later as a 422
 * from the relay, which is the failure this exists to prevent.
 */
export function canonicalizePng(bytes: Uint8Array): Uint8Array {
  for (const [index, expected] of SIGNATURE.entries()) {
    if (bytes[index] !== expected) {
      throw new Error("canonicalizePng: not a PNG");
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept: Uint8Array[] = [bytes.subarray(0, SIGNATURE.length)];
  let offset = SIGNATURE.length;
  let sawEnd = false;

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new Error("canonicalizePng: truncated chunk header");
    }
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) {
      throw new Error("canonicalizePng: chunk runs past the end of the file");
    }
    const kind = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    if (!isAncillary(kind) || KEPT_ANCILLARY.has(kind)) {
      kept.push(bytes.subarray(offset, end));
    }
    offset = end;
    if (kind === "IEND") {
      sawEnd = true;
      break;
    }
  }

  if (!sawEnd) {
    throw new Error("canonicalizePng: no IEND chunk");
  }
  // Trailing bytes after IEND are their own metadata channel, and the relay
  // rejects them too. Dropping them is why this rebuilds rather than splices.
  const total = kept.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of kept) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}
