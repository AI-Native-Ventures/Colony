// site/src/brand/hue.ts
// The Colony random-hue mechanic: on every page load, index.html's inline
// script (which must run before any bundled JS, before first paint) picks
// one of the five brand hues and stamps it on <html data-hue> plus two CSS
// custom properties. This module is the runtime source of truth for the
// derived color scales that key off that pick. index.html duplicates the
// canvas/accent hex tables by hand, the same hand-sync convention already
// used by AntMark.tsx and palette.ts in this directory, because the FOUC
// script cannot import from the bundle it runs ahead of. Keep both copies
// identical.
import {
  COLONY_AMBER,
  COLONY_BLUE,
  COLONY_GREEN,
  COLONY_PINK,
  COLONY_VIOLET,
} from "./palette";

export type HueName = "violet" | "blue" | "pink" | "amber" | "green";

export const HUE_NAMES: HueName[] = [
  "violet",
  "blue",
  "pink",
  "amber",
  "green",
];

/** Ink stays constant across every hue, so text treatment never changes,
 * only the canvas underneath it does. */
export const COLONY_INK = "#171717";

/** Raw brand accent per hue: the existing palette.ts values, unchanged.
 * Reserved for small decorative accents (badges, borders) at reduced
 * opacity or against an ink surface. Do not use as text color directly on
 * the canvas tint below: same hue family, close lightness, contrast is
 * unreliable. */
export const HUE_ACCENT: Record<HueName, string> = {
  violet: COLONY_VIOLET,
  blue: COLONY_BLUE,
  pink: COLONY_PINK,
  amber: COLONY_AMBER,
  green: COLONY_GREEN,
};

/** Full-bleed canvas tint per hue: lightness raised from the raw palette
 * value until #171717 ink clears 7:1 against it. Measured values recorded
 * in .superpowers/sdd/2026-07-31-colony-rebrand/hero-rebuild-report.md.
 * Keep this table and index.html's copy identical. */
export const HUE_CANVAS: Record<HueName, string> = {
  violet: "#B394F9", // hsl(258 90% 78%)
  blue: "#72A5F8", // hsl(217 91% 71%)
  pink: "#F17EB8", // hsl(330 81% 72%)
  amber: "#F59F0A", // hsl(38 92% 50%), unchanged from the raw palette value
  green: "#33CC99", // hsl(160 60% 50%)
};

/** Tonal scatter palette per hue: a dark shade, the raw accent, a pale
 * tint, and white, so the scatter field reads as texture (per buzz.xyz's
 * tonal bees: white and pale yellow on chartreuse) instead of five
 * competing confetti colors. The pale tint is deliberately lighter than
 * HUE_CANVAS so a tinted ant never matches the background it sits on. */
export const HUE_SCATTER_TONES: Record<HueName, string[]> = {
  violet: ["hsl(258 90% 44%)", COLONY_VIOLET, "hsl(258 90% 92%)", "#ffffff"],
  blue: ["hsl(217 91% 38%)", COLONY_BLUE, "hsl(217 91% 85%)", "#ffffff"],
  pink: ["hsl(330 81% 38%)", COLONY_PINK, "hsl(330 81% 86%)", "#ffffff"],
  amber: ["hsl(38 92% 28%)", COLONY_AMBER, "hsl(38 92% 64%)", "#ffffff"],
  green: ["hsl(160 60% 23%)", COLONY_GREEN, "hsl(160 60% 64%)", "#ffffff"],
};

/** Reads the hue index.html's inline script already picked and stamped
 * onto <html data-hue> before this module ever evaluates. Falls back to
 * violet if the attribute is somehow missing (script blocked, non-browser
 * render, e.g. during `tsc`/build-time type checks). */
export function getActiveHue(): HueName {
  if (typeof document === "undefined") return "violet";
  const attr = document.documentElement.dataset.hue as HueName | undefined;
  return attr && HUE_NAMES.includes(attr) ? attr : "violet";
}
