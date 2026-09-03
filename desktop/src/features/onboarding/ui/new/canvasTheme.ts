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
export const HUE_CANVAS: Record<HueName, string> = {
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
  /** Fill for a primary action that cannot be pressed yet. */
  disabledBg: string;
  /** Label colour on that fill, whichever of ink and white reads on it. */
  disabledInk: string;
};

function channels(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function toHex(value: number): string {
  return Math.round(value).toString(16).padStart(2, "0");
}

/** `amount` of `b` blended into `a`, in plain sRGB. */
function mix(a: string, b: string, amount: number): string {
  const from = channels(a);
  const to = channels(b);
  return `#${from.map((value, index) => toHex(value + (to[index] - value) * amount)).join("")}`;
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/**
 * How far the disabled fill is pushed from the canvas tint toward ink, and the
 * least legible its label is allowed to be.
 *
 * A disabled action still has to be seen: it is the thing someone is trying to
 * reach, and on these canvases it has to separate from the field behind it
 * while staying obviously unpressable. 0.3 is what puts it about 1.75:1 against
 * its own canvas, a shade rather than a second colour.
 */
const DISABLED_MIX = 0.3;
const DISABLED_MIX_STEP = 0.05;
const DISABLED_MIN_CONTRAST = 3;

/**
 * The disabled fill and label for one hue.
 *
 * Derived rather than fixed. The whole flow used one lilac at half opacity,
 * which is muddy rose on the amber screens and nearly invisible on pink: a
 * colour chosen against one canvas cannot work on five. This darkens the
 * screen's own hue toward ink and then keeps darkening, a step at a time,
 * until the better of ink and white clears 3:1 on it, so the guarantee holds
 * for whatever hues the table carries later.
 */
export function disabledActionColours(base: string): {
  disabledBg: string;
  disabledInk: string;
} {
  let amount = DISABLED_MIX;
  let disabledBg = mix(base, COLONY_INK, amount);
  let disabledInk = mostLegibleInk(disabledBg);
  while (
    contrastRatio(disabledInk, disabledBg) < DISABLED_MIN_CONTRAST &&
    amount < 1
  ) {
    amount = Math.min(1, amount + DISABLED_MIX_STEP);
    disabledBg = mix(base, COLONY_INK, amount);
    disabledInk = mostLegibleInk(disabledBg);
  }
  return { disabledBg, disabledInk };
}

/**
 * Ink or white, whichever reads on the fill.
 *
 * The hue system's rule is that ink never changes while the canvas does, and
 * that holds for every screen here: on the mid-tone amber and green fills ink
 * is the more legible of the two. The lighter violet, blue and pink fills are
 * where it stops being true, and a label no one can read is not a rule worth
 * keeping.
 */
function mostLegibleInk(fill: string): string {
  return contrastRatio(COLONY_INK, fill) >= contrastRatio("#ffffff", fill)
    ? COLONY_INK
    : "#ffffff";
}

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
  const base = HUE_CANVAS[hue];
  return { base, ink: "dark", hue, ...disabledActionColours(base) };
}
