/**
 * The render path, exposed to a browser test.
 *
 * The renderer's whole reason for living in the app is that the app is a
 * WebKit view, and `foreignObject` rasterisation has a history of failing
 * there. A node test cannot prove any of it: the gates' maths is unit-tested,
 * but "does the card actually draw, in this engine" is a question only an
 * engine can answer. This module is what the spec injects to ask it.
 */

import { loadKitFontFace } from "../../../src/features/content/render/fontKit";
import type { CardSpec } from "../../../src/features/content/render/compositions";
import { renderSlide } from "../../../src/features/content/render/renderSlide";

declare global {
  interface Window {
    __COLONY_RENDER_SLIDE__: (
      card: CardSpec,
      kit?: unknown,
    ) => Promise<{
      sha256: string;
      width: number;
      height: number;
      pixelVariance: number;
      contrast: { label: string; ratio: number }[];
      grain: { quietGrain: number };
      font: { delta: number; pass: boolean; reason?: string };
    }>;
  }
}

window.__COLONY_RENDER_SLIDE__ = async (card: CardSpec, kit?: unknown) => {
  const fontFaceCss = await loadKitFontFace();
  const slide = await renderSlide(card, {
    fontFaceCss,
    kit: kit as never,
  });
  return {
    contrast: slide.contrast.map((run) => ({
      label: run.label,
      ratio: run.ratio,
    })),
    font: slide.font,
    grain: { quietGrain: slide.grain.quietGrain },
    height: slide.height,
    pixelVariance: slide.pixelVariance,
    sha256: slide.sha256,
    width: slide.width,
  };
};
