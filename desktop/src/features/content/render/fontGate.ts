/**
 * Proof that the kit's own typeface reached the raster.
 *
 * Inside a `foreignObject` a font referenced by family name or URL silently
 * falls back to a system face. The card still renders, still measures fine on
 * contrast, and is wrong in the one way a customer notices immediately. So the
 * renderer inlines the face as a base64 data URI, and this gate proves the
 * inlining worked.
 *
 * **Why not measure text width.** The obvious check is to lay the same string
 * out in the kit face and in a system face and compare widths. That proves the
 * DOM measured differently; it says nothing about what landed in the raster,
 * because layout and rasterisation are separate steps and only the second one
 * goes through `foreignObject`. A width probe passes while the PNG falls back.
 *
 * **What this does instead.** Rasterise the card twice, once with the inline
 * `@font-face` and once with it removed, and compare mean absolute luminance
 * inside the text box. If the face reached the raster, the glyphs differ and
 * the number moves. The spike measured a delta of 20.1 on a headline box; a
 * fallback scores near zero because both frames drew the same system face.
 *
 * Found by a second agent replicating the WebKit spike independently, which is
 * why the delta is a measurement rather than a guess. See
 * `desktop/tests/spikes/webkit-rasterisation-spike.mjs`.
 */

import { luminancePlane } from "./grain";

/** A rectangle in device pixels. */
export type Box = { x: number; y: number; width: number; height: number };

/** What the gate reports. */
export type FontGateResult = {
  /** Mean absolute luminance difference inside the box, 0-255 units. */
  delta: number;
  /** Whether the face demonstrably reached the raster. */
  pass: boolean;
  /** Why, when it did not. */
  reason?: string;
};

/**
 * The floor a real face has to clear.
 *
 * The spike measured 20.1 with the kit face against the same card drawn
 * without it. 2.0 is an order of magnitude below that and still far above the
 * noise a renderer produces between two identical frames, so it separates
 * "different glyphs" from "same glyphs, resampled" without being tuned to one
 * measurement.
 */
export const FALLBACK_FLOOR = 2;

/**
 * Mean absolute luminance difference between two frames, inside one box.
 *
 * Both frames must be the same size: they are two rasterisations of one card,
 * and comparing different geometries would measure the layout rather than the
 * face.
 */
export function meanAbsoluteDelta(
  withFace: Uint8ClampedArray,
  withoutFace: Uint8ClampedArray,
  width: number,
  height: number,
  box: Box,
): number {
  if (withFace.length !== withoutFace.length) {
    throw new Error(
      "font gate: the two frames differ in size, so they are not two rasters of one card",
    );
  }
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.width));
  const y1 = Math.min(height, Math.ceil(box.y + box.height));
  if (x1 - x0 < 1 || y1 - y0 < 1) {
    throw new Error("font gate: the text box is empty");
  }

  const a = luminancePlane(withFace, width, height);
  const b = luminancePlane(withoutFace, width, height);
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      sum += Math.abs(a[y * width + x] - b[y * width + x]);
      n++;
    }
  }
  return Math.round((sum / n) * 100) / 100;
}

/**
 * Whether the kit face reached the raster.
 *
 * `withoutFace` is the same card rendered with the `@font-face` rule stripped
 * from its stylesheet, which is what {@link stripFontFaces} produces.
 */
export function fontReachedRaster(
  withFace: Uint8ClampedArray,
  withoutFace: Uint8ClampedArray,
  width: number,
  height: number,
  box: Box,
  floor: number = FALLBACK_FLOOR,
): FontGateResult {
  const delta = meanAbsoluteDelta(withFace, withoutFace, width, height, box);
  if (delta < floor) {
    return {
      delta,
      pass: false,
      reason:
        `the kit face did not reach the raster: removing it changed the text ` +
        `box by ${delta} luminance units, under the floor of ${floor}. Inside ` +
        `foreignObject a font referenced by name or URL falls back silently, ` +
        `so the face must be inlined as a base64 data: URI`,
    };
  }
  return { delta, pass: true };
}

/**
 * The card's stylesheet with every `@font-face` rule removed, for the control
 * frame.
 *
 * Brace-balanced rather than `[^}]*`: a base64 payload happens never to
 * contain a closing brace, but a parser has no business assuming that. Same
 * reasoning as the reader in `capture.ts`, which was originally written with a
 * character class and truncated a data URI at the `;` inside `;base64,`.
 */
export function stripFontFaces(css: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const at = css.indexOf("@font-face", from);
    if (at < 0) {
      out += css.slice(from);
      return out;
    }
    const open = css.indexOf("{", at);
    if (open < 0) {
      out += css.slice(from);
      return out;
    }
    out += css.slice(from, at);
    let depth = 1;
    let quote: string | null = null;
    let i = open + 1;
    for (; i < css.length && depth > 0; i++) {
      const ch = css[i];
      if (quote) {
        if (ch === "\\") {
          i++;
        } else if (ch === quote) {
          quote = null;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
      }
    }
    from = i;
  }
}
