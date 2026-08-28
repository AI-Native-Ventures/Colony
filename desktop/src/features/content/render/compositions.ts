/**
 * Card compositions: ground, one phrase, no furniture.
 *
 * Port of `colony-social-kit/tools/build-posts.mjs`. The direction is Sierra
 * and OpenAI: one atmospheric ground, one short phrase in a medium weight,
 * nothing else on the card. Difference between cards comes from the field,
 * which is a different colour and a different shape every time, not from added
 * elements.
 *
 * Every hue value flows in through the kit-resolved slices; no composition may
 * hardcode Colony's palette. The ink constant comes from colonyKit.ts because
 * dawn cards set their type in it.
 */

import {
  accentColor,
  ATMOSPHERE_CSS,
  atmosphere,
  GROUND_BAND,
  type GroundFamily,
  type ResolvedGroundHue,
} from "./atmosphere.ts";
import { INK, resolveGroundHues } from "./colonyKit.ts";
import type { BrandKit } from "./kit.ts";

/** Canvas size of the kit's launch canvas. */
export const CANVAS_W = 1080;
export const CANVAS_H = 1350;
const PAD = 96;

/**
 * The authored fields one slide needs to render. This is the render-facing
 * subset of a post entry in `content/weeks.mjs`: everything here is authored,
 * sourced copy, never generated mid-render.
 */
export type CardSpec = {
  /** Trailing phrase set in the card's lead hue. Must appear in headline. */
  accent?: string;
  family: GroundFamily;
  /** Status pill above the headline. Poster only; ignored elsewhere. */
  badge?: string;
  /** The small caps line under the mark on countdown cards. */
  footLine?: string;
  headline: string;
  /** Hue names, dominant first; resolved against the brand kit. */
  hues: string[];
  layout: string;
  size?: number;
  slug: string;
};

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Headline HTML. If the card names an `accent`, that trailing phrase is set in
 * the card's lead hue and tagged for its own contrast run, because an accent
 * word sitting over a different part of the field is exactly where a colour
 * that reads fine in isolation stops clearing the bar.
 */
function headline(card: CardSpec, color: string, accent: string): string {
  const text = esc(card.headline);
  if (!card.accent) {
    return `<span data-contrast="headline" style="color:${color}">${text.replace(/\n/g, "<br>")}</span>`;
  }
  const accentText = esc(card.accent);
  const at = text.lastIndexOf(accentText);
  if (at < 0) {
    throw new Error(
      `${card.slug}: accent "${card.accent}" is not in the headline`,
    );
  }
  const before = text.slice(0, at).replace(/\n/g, "<br>");
  const after = text.slice(at + accentText.length).replace(/\n/g, "<br>");
  return (
    `<span data-contrast="headline" style="color:${color}">${before}</span>` +
    `<span data-contrast="headline accent" style="color:${accent}">${accentText}</span>` +
    (after
      ? `<span data-contrast="headline" style="color:${color}">${after}</span>`
      : "")
  );
}

// The ant mark SVG is injected per render by geometry.ts's antSvg(); this
// placeholder keeps the lockup box present so contrast runs can sample it.
function lockup(card: CardSpec, color: string, markSvg: string): string {
  return `<div class="lockup" data-contrast="lockup" style="color:${color}">
    <div class="lockup-mark">${markSvg}</div>
    ${card.footLine ? `<div class="lockup-line" data-contrast="countdown line" style="color:${color}">${esc(card.footLine)}</div>` : ""}
  </div>`;
}

/** Ground colours for a card. Night carries white type on the deep ramp; dawn
 * carries ink on the high-key one. The accent is not chosen here, it is solved
 * from the ground in atmosphere.ts. */
function palette(
  family: GroundFamily,
  hues: ResolvedGroundHue[],
): { accent: string; lockup: string; type: string } {
  return family === "night"
    ? { accent: accentColor("night", hues), lockup: "#ffffff", type: "#ffffff" }
    : { accent: accentColor("dawn", hues), lockup: INK, type: INK };
}

const headSize = (card: CardSpec, fallback: number): number =>
  card.size ?? fallback;

/**
 * The status pill.
 *
 * Tagged for its own contrast run: it sits higher on the card than the
 * headline, which on a card whose light source is up there is exactly where a
 * colour that reads fine at the centre stops clearing the bar.
 */
function badge(card: CardSpec, color: string): string {
  if (!card.badge) {
    return "";
  }
  return `<div class="badge" data-contrast="badge" style="color:${color};border-color:${color}">${esc(card.badge)}</div>`;
}

/**
 * Layouts. Each one is the same three elements (ground, one phrase, lockup) in
 * a different arrangement; nothing is added to a card to make it look
 * different from the one before it.
 */
export const LAYOUTS: Record<
  string,
  (
    card: CardSpec,
    p: { accent: string; lockup: string; type: string },
    markSvg: string,
  ) => string
> = {
  // The phrase, held in the middle of the field.
  statement: (card, p, markSvg) => `
    <div class="page">
      <div class="spacer"></div>
      <h1 style="font-size:${headSize(card, 108)}px">${headline(card, p.type, p.accent)}</h1>
      <div class="spacer"></div>
      ${lockup(card, p.lockup, markSvg)}
    </div>`,

  // The one scale break the rest of the set cannot make.
  poster: (card, p, markSvg) => `
    <div class="page">
      <div class="spacer"></div>
      ${badge(card, p.type)}
      <h1 class="big" style="font-size:${headSize(card, 156)}px">${headline(card, p.type, p.accent)}</h1>
      <div class="spacer"></div>
      ${lockup(card, p.lockup, markSvg)}
    </div>`,
};

/**
 * Base CSS every card shares. The vendored face arrives as an inline base64
 * @font-face supplied by the caller: inside foreignObject a font referenced by
 * name or URL silently falls back, so it must be embedded (see the capture
 * path and the zero-font-fallback gate).
 */
export function cardCss(fontFaceCss: string): string {
  return `${fontFaceCss}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${CANVAS_W}px;height:${CANVAS_H}px}
body{font-family:"Inter Kit",sans-serif;-webkit-font-smoothing:antialiased;overflow:hidden;position:relative;background:${INK}}
${ATMOSPHERE_CSS}
.page{position:absolute;inset:0;padding:${PAD}px;display:flex;flex-direction:column;align-items:center;text-align:center;z-index:2}
.spacer{flex:1 1 auto;min-height:0}

/* One phrase. Both references set their type at a medium weight with tight
   tracking, not at black weight: at poster scale a 700 face closes up its own
   counters and the phrase stops being readable at thumbnail size. */
h1{font-weight:600;letter-spacing:-.035em;line-height:1.06;text-wrap:balance}
h1.big{font-weight:650;letter-spacing:-.048em;line-height:.98}

/* Status pill. Sits above the headline with the same weight of presence as
   the lockup line below it: uppercase, tracked out, no fill. */
.badge{flex:none;margin-bottom:28px;padding:10px 26px;border:1.5px solid;border-radius:999px;font-size:22px;font-weight:600;letter-spacing:.14em;text-transform:uppercase}

/* Lockup: the mark, centred, the way Sierra closes every card. */
.lockup{flex:none;display:flex;flex-direction:column;align-items:center;gap:26px}
.lockup-mark{width:96px}
.lockup-mark svg{display:block;width:100%;height:auto}
.lockup-line{font-size:23px;font-weight:600;letter-spacing:.24em;text-transform:uppercase}
`;
}

/** The mark as drawn on cards: currentColour follows the lockup colour. */
function cardMark(color: string): string {
  // Deferred import avoided: geometry.ts has no heavy dependencies.
  return antSvgInline(color);
}

import { antSvg as antSvgImpl } from "./geometry.ts";

function antSvgInline(color: string): string {
  // geometry.ts emits viewBox-only svg; the card needs explicit pixel sizing,
  // which the .lockup-mark css already applies.
  return antSvgImpl({ color });
}

/**
 * The full card document for one slide: ground first, layout over it, both
 * under one style sheet. Deterministic in the slug, so the same card always
 * renders the same pixels given the same engine.
 */
export function cardHtml(
  card: CardSpec,
  options: { fontFaceCss: string; kit?: BrandKit },
): string {
  const build = LAYOUTS[card.layout];
  if (!build) {
    throw new Error(`${card.slug}: unknown layout ${card.layout}`);
  }
  const hues = resolveGroundHues(card.family, card.hues, options.kit);
  const p = palette(card.family, hues);
  const groundBand = GROUND_BAND[card.layout];
  if (!groundBand) {
    throw new Error(`${card.slug}: no ground band for layout ${card.layout}`);
  }
  const mark = cardMark(p.lockup);
  return `<style>${cardCss(options.fontFaceCss)}</style><body>
${atmosphere({ band: groundBand.band, family: card.family, hues, reach: groundBand.reach, seed: card.slug }, CANVAS_W, CANVAS_H)}
${build(card, p, mark)}
</body>`;
}
