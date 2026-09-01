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

import type { BrandKit, MarkVariantPurpose } from "./kit";
import type { CardMark } from "./marks";
import {
  chooseKitMark,
  fallbackMark,
  imageMark,
  markDataUri,
  sniffImageMime,
  variantMark,
} from "./marks";
import { INK } from "./colonyKit";
import { hexToRgb } from "./color";
import {
  borderBackground,
  hasTransparency,
  removeBackground,
  silhouette,
} from "./logoVariants";

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
/** Fetch one media hash to a data URI, through the cache. Null on failure. */
async function fetchMarkUri(
  mediaHash: string,
  mediaUrl: string,
): Promise<string | null> {
  const cached = markCache.get(mediaHash);
  if (cached) {
    return cached;
  }
  try {
    const bytes = new Uint8Array(
      await fetchMediaBytes(rewriteRelayUrl(mediaUrl)),
    );
    const mime = sniffImageMime(bytes);
    if (!mime) {
      return null;
    }
    const uri = markDataUri(bytes, mime);
    markCache.set(mediaHash, uri);
    return uri;
  } catch {
    return null;
  }
}

export async function resolveCardMark(kit: BrandKit | null): Promise<CardMark> {
  if (!kit) {
    return fallbackMark(null);
  }
  const mark = chooseKitMark(kit);
  if (!mark) {
    return fallbackMark(kit);
  }
  const base = await fetchMarkUri(mark.media_hash, mark.media_url);
  if (!base) {
    return fallbackMark(kit);
  }
  if (mark.variants.length === 0) {
    return imageMark(base);
  }
  // Variants fetched with the same forgiveness as the base: any that fail
  // simply leave the original to cover their ground.
  const byPurpose = new Map<MarkVariantPurpose, string>();
  for (const variant of mark.variants) {
    const uri = await fetchMarkUri(variant.media_hash, variant.media_url);
    if (uri && !byPurpose.has(variant.purpose)) {
      byPurpose.set(variant.purpose, uri);
    }
  }
  return variantMark({
    base,
    onDark: byPurpose.get("on-dark"),
    onLight: byPurpose.get("on-light"),
  });
}

/** The derived versions of one logo, each as PNG bytes ready to upload. */
export type DerivedLogoVariants = {
  /** The original with any flat background lifted off. */
  base: Uint8Array;
  /** White version, for dark grounds. */
  onDark: Uint8Array;
  /** Ink version, for light grounds. */
  onLight: Uint8Array;
};

async function decodeToCanvas(
  bytes: Uint8Array,
): Promise<{ canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }> {
  const mime = sniffImageMime(bytes);
  if (!mime || mime === "image/svg+xml") {
    throw new Error("This logo is not an image the app can read.");
  }
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("This logo could not be decoded."));
    // data:, never blob:: a blob URL taints the canvas in both engines and
    // getImageData then throws.
    img.src = markDataUri(bytes, mime);
  });
  const scale = Math.min(1, 1024 / Math.max(img.width || 1, img.height || 1));
  const width = Math.max(1, Math.round((img.width || 1) * scale));
  const height = Math.max(1, Math.round((img.height || 1) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("No canvas is available to work on the logo.");
  }
  context.drawImage(img, 0, 0, width, height);
  return { canvas, context };
}

async function encodePng(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  data: Uint8ClampedArray<ArrayBuffer>,
): Promise<Uint8Array> {
  context.putImageData(new ImageData(data, canvas.width, canvas.height), 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) {
    throw new Error("The logo version could not be saved as an image.");
  }
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Derive the versions of a logo the cards need: background lifted, a white
 * one for dark grounds, an ink one for light grounds.
 *
 * Never throws for an undecodable input beyond what `decodeToCanvas` raises;
 * a logo whose border is not a flat colour keeps its pixels and only the
 * silhouettes are derived from what is visible.
 */
export async function deriveLogoVariants(
  bytes: Uint8Array,
): Promise<DerivedLogoVariants> {
  const { canvas, context } = await decodeToCanvas(bytes);
  const source = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let cleaned = source;
  if (!hasTransparency(source)) {
    const background = borderBackground(source, canvas.width, canvas.height);
    if (background) {
      cleaned = removeBackground(
        source,
        canvas.width,
        canvas.height,
        background,
      );
    }
  }
  const ink = hexToRgb(INK).rgb;
  const onDark = silhouette(cleaned, [255, 255, 255]);
  const onLight = silhouette(cleaned, ink);
  return {
    base: await encodePng(canvas, context, cleaned),
    onDark: await encodePng(canvas, context, onDark),
    onLight: await encodePng(canvas, context, onLight),
  };
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
