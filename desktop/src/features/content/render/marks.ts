/**
 * The mark a card closes with, resolved from the brand kit.
 *
 * Until this module existed every card drew Colony's ant, hardcoded via
 * `geometry.ts`, whichever workspace was rendering. The kit schema always had
 * a `marks[]` field (role, media hash, media url) and nothing read it. Now the
 * renderer does: a workspace's cards carry that workspace's logo, and the ant
 * is what it always should have been, one brand's mark rather than the
 * system's.
 *
 * A mark is a function of the lockup colour rather than a string because the
 * ant follows the card's type colour (white on night grounds, ink on dawn),
 * while a raster logo carries its own colours and ignores the argument. The
 * composition does not need to know which kind it holds.
 *
 * This module is pure so it tests in node. Everything that touches the
 * network or a canvas lives in `marksRuntime.ts`.
 */

import type { BrandKit, BrandMark } from "./kit";
import { antSvg } from "./geometry";

/** Renders the `.lockup-mark` contents for one lockup colour. */
export type CardMark = (lockupColor: string) => string;

/** Colony's own mark. Follows the lockup colour like type does. */
export const antMark: CardMark = (color) => antSvg({ color });

/** No mark at all: a brand that has not confirmed a logo shows nothing
 * rather than someone else's mark. */
export const noMark: CardMark = () => "";

/** A raster (or inline-SVG-data) logo. Brand logos carry their own colours,
 * so the lockup colour is ignored. */
export function imageMark(dataUri: string): CardMark {
  return () => `<img src="${dataUri}" alt="">`;
}

/**
 * Sniff the mime of logo bytes by magic numbers.
 *
 * Sniffed rather than trusted from a filename because the bytes are fetched
 * back off the relay, and the data: URI built from them must name what they
 * actually are or the image silently fails to decode inside the card.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i] ?? 0;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return "image/png";
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return "image/jpeg";
  }
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return "image/webp";
  }
  // SVG has no magic number; look for the root element in the first bytes.
  const head = new TextDecoder()
    .decode(bytes.subarray(0, 256))
    .trimStart()
    .toLowerCase();
  if (head.startsWith("<svg") || head.startsWith("<?xml")) {
    return "image/svg+xml";
  }
  return null;
}

/** Encode logo bytes as a data: URI (never blob:, which taints the canvas). */
export function markDataUri(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/**
 * The kit mark a card should draw, or null when the kit carries none.
 *
 * Icons first: the lockup box is 96px square-ish, which is icon territory. A
 * kit with only a wide wordmark still closes its cards with it rather than
 * with nothing.
 */
export function chooseKitMark(kit: BrandKit): BrandMark | null {
  for (const role of ["icon", "logo", "wordmark"] as const) {
    const found = kit.marks.find((mark) => mark.role === role);
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * Whether a kit is Colony's own, and so may fall back to the ant.
 *
 * Any other workspace whose kit names no mark renders no mark: shipping the
 * ant on someone else's brand is exactly the hardcoding this module removed.
 */
export function isColonyKit(kit: BrandKit | null): boolean {
  if (!kit) {
    // No kit at all means the renderer is already on Colony's built-in
    // fallback palette, so the built-in mark matches it.
    return true;
  }
  if (kit.id === "colony") {
    return true;
  }
  return (
    kit.source.type === "scan" &&
    /(^|\.)colony\.ainative\.ventures(\/|$)/.test(
      kit.source.url.replace(/^https?:\/\//, ""),
    )
  );
}

/** The mark for a kit whose logo bytes could not be resolved (or that has
 * none): Colony's ant for Colony, nothing for anyone else. */
export function fallbackMark(kit: BrandKit | null): CardMark {
  return isColonyKit(kit) ? antMark : noMark;
}
