import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizePng } from "./canonicalPng.ts";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** CRC-32, so the chunks this builds are well formed rather than plausible. */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(kind, payload) {
  const body = new Uint8Array(kind.length + payload.length);
  body.set(
    [...kind].map((c) => c.charCodeAt(0)),
    0,
  );
  body.set(payload, kind.length);
  const out = new Uint8Array(body.length + 8);
  new DataView(out.buffer).setUint32(0, payload.length);
  out.set(body, 4);
  new DataView(out.buffer).setUint32(out.length - 4, crc32(body));
  return out;
}

function png(chunks) {
  const parts = [Uint8Array.from(SIGNATURE), ...chunks];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/** Chunk types in order, which is what the relay's validator walks. */
function kinds(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found = [];
  let offset = SIGNATURE.length;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    found.push(
      String.fromCharCode(
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7],
      ),
    );
    offset += 12 + length;
  }
  return found;
}

const IHDR = chunk("IHDR", new Uint8Array(13));
const IDAT = chunk("IDAT", Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
const IEND = chunk("IEND", new Uint8Array(0));

test("the chunks the relay answers 422 for are removed", () => {
  // Every type in the relay's forbidden set, plus a private ancillary chunk
  // and pHYs, which it excludes on purpose as an identity channel.
  const forbidden = ["eXIf", "iCCP", "zTXt", "iTXt", "pHYs", "prVt"];
  const dirty = png([
    IHDR,
    ...forbidden.map((kind) => chunk(kind, Uint8Array.from([9, 9, 9]))),
    IDAT,
    IEND,
  ]);
  assert.deepEqual(kinds(dirty), ["IHDR", ...forbidden, "IDAT", "IEND"]);

  assert.deepEqual(kinds(canonicalizePng(dirty)), ["IHDR", "IDAT", "IEND"]);
});

test("a tEXt chunk goes even though the relay allowlists one keyword", () => {
  // The relay keeps a single snapshot manifest in tEXt. A card carries no
  // manifest, so the safe move is to drop it rather than match a keyword.
  const dirty = png([IHDR, chunk("tEXt", Uint8Array.from([65])), IDAT, IEND]);
  assert.deepEqual(kinds(canonicalizePng(dirty)), ["IHDR", "IDAT", "IEND"]);
});

test("rendering chunks the relay keeps are kept", () => {
  const rendering = ["cHRM", "gAMA", "sBIT", "sRGB", "bKGD", "tRNS", "sPLT"];
  const clean = png([
    IHDR,
    ...rendering.map((kind) => chunk(kind, Uint8Array.from([1]))),
    IDAT,
    IEND,
  ]);
  assert.deepEqual(kinds(canonicalizePng(clean)), [
    "IHDR",
    ...rendering,
    "IDAT",
    "IEND",
  ]);
});

test("the image data survives byte for byte", () => {
  // The whole reason this edits the container instead of re-encoding: the
  // gate report names the hash of these bytes, so the pixels may not move.
  const dirty = png([IHDR, chunk("pHYs", Uint8Array.from([1])), IDAT, IEND]);
  const clean = canonicalizePng(dirty);
  const start = clean.length - IEND.length - IDAT.length;
  assert.deepEqual([...clean.subarray(start, start + IDAT.length)], [...IDAT]);
});

test("bytes trailing IEND are dropped, not carried", () => {
  const withTrailer = new Uint8Array([
    ...png([IHDR, IDAT, IEND]),
    0xde,
    0xad,
    0xbe,
    0xef,
  ]);
  const clean = canonicalizePng(withTrailer);
  assert.equal(clean.length, png([IHDR, IDAT, IEND]).length);
  assert.deepEqual(kinds(clean), ["IHDR", "IDAT", "IEND"]);
});

test("an already canonical PNG is returned unchanged", () => {
  const clean = png([IHDR, IDAT, IEND]);
  assert.deepEqual([...canonicalizePng(clean)], [...clean]);
});

test("input that is not a PNG is refused rather than passed through", () => {
  // Passing it through would surface as a 422 from the relay instead, which
  // is the failure this module exists to prevent.
  assert.throws(
    () => canonicalizePng(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])),
    /not a PNG/,
  );
});

test("a chunk running past the end is refused", () => {
  const truncated = png([IHDR, IDAT, IEND]).subarray(0, 20);
  assert.throws(() => canonicalizePng(truncated), /canonicalizePng:/);
});
