/**
 * Resolving a kit's mark into embeddable bytes, inside the app.
 *
 * Split from `marks.ts` the way `claimVerifierRuntime.ts` is split from its
 * pure half: this file touches the network and the DOM, so the logic it wraps
 * stays testable in node.
 *
 * The logo reaches the card as a data: URI. Inside the capture path's
 * foreignObject an external URL is a taint hazard and a race (the rasteriser
 * does not wait for subresource loads), so the bytes are fetched here, once,
 * and inlined. Fetches are cached by media hash; a failed fetch is not
 * cached, and the card falls back to `fallbackMark` rather than refusing to
 * render: a missing logo is the owner's to fix from the Brand page, and a
 * calendar that cannot draw at all gives them no way to see that.
 */

import { fetchMediaBytes } from "@/shared/api/tauriMedia";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";

import type { BrandKit } from "./kit";
import type { CardMark } from "./marks";
import {
  chooseKitMark,
  fallbackMark,
  imageMark,
  markDataUri,
  sniffImageMime,
} from "./marks";

/** Data URIs by mark media hash. Community-scoped: reset on switch. */
let markCache = new Map<string, string>();

/** Wired into `resetCommunityState()`; a cached logo must not follow the
 * owner into another workspace's cards. */
export function resetMarkCache(): void {
  markCache = new Map();
}

/**
 * The mark this kit's cards close with.
 *
 * Never throws: a kit without a resolvable mark falls back (ant for Colony's
 * own kit, nothing for anyone else's) so a broken logo URL degrades to a
 * missing mark instead of a dead calendar.
 */
export async function resolveCardMark(kit: BrandKit | null): Promise<CardMark> {
  if (!kit) {
    return fallbackMark(null);
  }
  const mark = chooseKitMark(kit);
  if (!mark) {
    return fallbackMark(kit);
  }
  const cached = markCache.get(mark.media_hash);
  if (cached) {
    return imageMark(cached);
  }
  try {
    const bytes = new Uint8Array(
      await fetchMediaBytes(rewriteRelayUrl(mark.media_url)),
    );
    const mime = sniffImageMime(bytes);
    if (!mime) {
      return fallbackMark(kit);
    }
    const uri = markDataUri(bytes, mime);
    markCache.set(mark.media_hash, uri);
    return imageMark(uri);
  } catch {
    return fallbackMark(kit);
  }
}

/**
 * Rasterise an SVG logo to a 512px PNG, for upload.
 *
 * The relay refuses `image/svg+xml` uploads outright, so an owner handing us
 * their logo as SVG gets it converted client-side. The SVG travels to the
 * image as a data: URI, never blob: — blob: taints the canvas in both
 * engines and `toBlob` then throws (see the capture path).
 */
export async function rasteriseSvgLogo(svgText: string): Promise<Uint8Array> {
  const uri = `data:image/svg+xml;base64,${btoa(
    String.fromCharCode(...new TextEncoder().encode(svgText)),
  )}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("This SVG could not be read."));
    img.src = uri;
  });
  const scale = 512 / Math.max(img.width || 512, img.height || 512, 1);
  const width = Math.max(1, Math.round((img.width || 512) * scale));
  const height = Math.max(1, Math.round((img.height || 512) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("No canvas is available to convert the logo.");
  }
  context.drawImage(img, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) {
    throw new Error("The logo could not be converted to an image.");
  }
  return new Uint8Array(await blob.arrayBuffer());
}
