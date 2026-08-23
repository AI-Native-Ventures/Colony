import type { OnboardingStep, OnboardingTrack } from "../../flow/steps";

/**
 * The landing page's hue system, ported.
 *
 * site/src/brand/hue.ts is the original and stays the source of truth. The
 * desktop package cannot import from the site package, so these tables are
 * hand-synced, the same convention palette.ts and AntMark.tsx already use.
 * Keep them identical.
 *
 * Three rules come from there, and none is negotiable here:
 *
 * 1. A screen is ONE hue, painted as a solid canvas tint. Not a gradient of
 *    several hues, which reads as a rainbow wash, and not a single hue for
 *    the whole flow, which reads as one long screen.
 * 2. Ink never changes. Only the canvas underneath it does, so the type
 *    treatment stays constant while colour marks where you are.
 * 3. Ants are tonal: a dark shade, the raw accent, a pale tint and white of
 *    the same hue. The landing page settled on that so the scatter field
 *    reads as texture rather than as five competing confetti colours.
 */
export type HueName = "violet" | "blue" | "pink" | "amber" | "green";

/** Ink stays constant across every hue. From site/src/brand/hue.ts. */
export const COLONY_INK = "#171717";

/**
 * Full-bleed canvas tint per hue. Lightness is raised from the raw brand
 * value until #171717 ink clears 7:1 against it, so these are contrast
 * measurements rather than taste. From site/src/brand/hue.ts.
 */
const HUE_CANVAS: Record<HueName, string> = {
  violet: "#B394F9",
  blue: "#72A5F8",
  pink: "#F17EB8",
  amber: "#F59F0A",
  green: "#33CC99",
};

/** Tonal scatter palette per hue. From site/src/brand/hue.ts. */
export const HUE_SCATTER_TONES: Record<HueName, string[]> = {
  violet: [
    "hsl(258 90% 44%)",
    "hsl(258 90% 66%)",
    "hsl(258 90% 92%)",
    "#ffffff",
  ],
  blue: ["hsl(217 91% 38%)", "hsl(217 91% 60%)", "hsl(217 91% 85%)", "#ffffff"],
  pink: ["hsl(330 81% 38%)", "hsl(330 81% 60%)", "hsl(330 81% 86%)", "#ffffff"],
  amber: ["hsl(38 92% 28%)", "hsl(38 92% 50%)", "hsl(38 92% 64%)", "#ffffff"],
  green: [
    "hsl(160 60% 23%)",
    "hsl(160 60% 45%)",
    "hsl(160 60% 64%)",
    "#ffffff",
  ],
};

export type CanvasTheme = {
  /** Solid canvas tint. One hue, no gradient. */
  base: string;
  /** "dark" means dark ink on a light field, which is every screen. */
  ink: "dark" | "light";
  /** The hue this screen wears, for the scatter field. */
  hue: HueName;
};

/**
 * Which hue each screen wears.
 *
 * Colour marks where you are, so neighbouring screens never repeat and the
 * five hues cycle across the flow. The landing page re-rolls its hue on every
 * load; here the sequence is fixed, because a person walks these in order and
 * a random colour per screen would read as noise rather than as progress.
 */
const SCREEN_HUE: Record<string, HueName> = {
  account: "violet",
  recovery: "blue",
  company: "amber",
  probing: "green",
  "brain:byo": "pink",
  "brain:colony": "violet",
  business: "amber",
  reading: "green",
  description: "pink",
  credits: "violet",
  invite: "blue",
};

export function canvasFor(
  step: OnboardingStep,
  track: OnboardingTrack,
): CanvasTheme {
  const key = step === "brain" ? `brain:${track}` : step;
  const hue = SCREEN_HUE[key] ?? "violet";
  return { base: HUE_CANVAS[hue], ink: "dark", hue };
}
