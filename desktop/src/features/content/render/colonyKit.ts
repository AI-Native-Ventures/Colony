/**
 * Colony's own brand kit, the first row of the kind 30198 table.
 *
 * Every other customer gets one of these derived from their website (ticket
 * 4) and corrected by hand. The renderer knows nothing about this file except
 * through the {@link BrandKit} shape and the {@link ContentMarkAssets}
 * interface, so nothing here may be reached around: hue values flow to the
 * templates through the kit parameter, never as literals in composition code.
 *
 * The ramps are solved, not picked: each stop below is the lightness at which
 * white (or ink) provably clears its stated ratio against the hue, ported
 * from the launch build's `brand/atmosphere.mjs` bisection. Picking swatches
 * by eye produced cards measuring 2.7:1 and 1.16:1 that the gate caught; the
 * solved ramp is what keeps the contrast gate from being a coin toss.
 */

import {
  hexToHsl,
  hexToRgb,
  luminanceHsl,
  solveInkOn,
  solveWhiteOn,
} from "./color.ts";
import type { BrandKit } from "./kit.ts";
import type { GroundFamily, ResolvedGroundHue } from "./atmosphere.ts";

/** Colony's ink. The value every dawn-family solve bottoms out against. */
export const INK = "#171717";

/** Relative luminance of #171717, kept next to its colour. */
export const INK_LUMINANCE = luminanceHsl(hexToHsl(INK));

/**
 * Named positions in the Colony kit's per-hue ramp.
 *
 * The wire record stores an ordered stop list; this map is the Colony-side
 * reading of what each position means. `safe` stops may sit anywhere on a
 * card including directly under type; `free` stops may sit only outside the
 * type band, which is where the light source lives.
 */
export const COLONY_RAMP = {
  /** White-type safe, darkest (clears 11:1). */
  nightSafe0: 0,
  /** White-type safe, mass tone (7.5:1). */
  nightSafe1: 1,
  /** White-type safe, lightest (5.8:1). */
  nightSafe2: 2,
  /** Ink-type safe floor: darkest lightness where ink still clears 5.5:1. */
  dawnSafe0: 3,
  /** Ink-type safe mid tone (ink clears 7.5:1). */
  dawnSafe1: 4,
  /** Ink-type safe lightest tone (ink clears 11:1). */
  dawnSafe2: 5,
  /** The palest canvas tint, free layer. */
  canvasLight: 6,
  /** The full-bleed canvas tint, free layer. */
  canvas: 7,
} as const;

function solvedRamp(baseHex: string): string[] {
  return [
    solveWhiteOn(baseHex, 11),
    solveWhiteOn(baseHex, 7.5),
    solveWhiteOn(baseHex, 5.8),
    solveInkOn(baseHex, 5.5, INK),
    solveInkOn(baseHex, 7.5, INK),
    solveInkOn(baseHex, 11, INK),
    // The two canvas tints come verbatim from the site's committed hue.ts
    // (copied into the launch kit's geometry.mjs); they are data, not solves.
    canvasLightTint(baseHex),
    canvasTint(baseHex),
  ];
}

/** Site canvas tints per hue base, copied verbatim from
 * `site/src/brand/hue.ts` by way of the launch kit's geometry.mjs. Lightness
 * there was raised until #171717 ink clears 7:1, which is why cards ground on
 * these rather than on the raw accent.
 */
const CANVAS_LIGHT: Record<string, string> = {
  "#895af6": "#F3EFFA",
  "#3c83f6": "#EFF3FA",
  "#ec4699": "#FBF4F7",
  "#f59f0a": "#FBF7EE",
  "#2eb88a": "#F1F9F6",
};

const CANVAS: Record<string, string> = {
  "#895af6": "#B394F9",
  "#3c83f6": "#72A5F8",
  "#ec4699": "#F17EB8",
  "#f59f0a": "#F59F0A",
  "#2eb88a": "#33CC99",
};

function hue(
  name: string,
  base: string,
): {
  name: string;
  base: string;
  ramp: string[];
} {
  // `solvedRamp` already ends with the canvas tint at the position
  // `COLONY_RAMP.canvas` names. Appending it again made a ninth stop that is a
  // duplicate of the eighth: harmless only because nothing reads past index 7,
  // which is exactly why it survived. A ramp whose length disagrees with its
  // named positions is the shape that made a derived kit unreadable.
  return { base, name, ramp: solvedRamp(base) };
}

/**
 * Colony's kit. Hue bases are the five committed palette hues converted from
 * their hsl form; ramps carry the eight solved stops named in
 * {@link COLONY_RAMP}.
 */
export const COLONY_KIT: BrandKit = {
  canvases: [{ h: 1350, name: "instagram-portrait-4-5", w: 1080 }],
  hues: [
    hue("violet", "#895af6"),
    hue("blue", "#3c83f6"),
    hue("pink", "#ec4699"),
    hue("amber", "#f59f0a"),
    hue("green", "#2eb88a"),
  ],
  id: "colony",
  marks: [],
  rules: {
    claim_strictness: "strict",
    contrast_floor: 4.5,
    // Measured quiet-region RMS on the launch build's ten cards, tuned to sit
    // just above the openai.com reference range (0.14-1.17) while keeping a
    // trace of texture. The gate reads this range out of the kit.
    raw: {
      grain: { max: 2.6, min: 1.0 },
    },
  },
  source: { type: "manual" },
  // Only what the app can actually draw. `wordmark` needs the site's own
  // wordmark vendored in, and `float` needs a product screenshot out of the
  // asset library; a kit that advertised either would hand an agent a layout
  // that throws at render time.
  templates: ["statement", "poster"],
  type: { families: ["Inter"], scale: {} },
  version: "colony-launch/1",
};

/** Resolved tint lookups the dawn family needs beyond the ramp stops. */
export function canvasLightTint(baseHex: string): string {
  return CANVAS_LIGHT[baseHex.toLowerCase()] ?? baseHex;
}

export function canvasTint(baseHex: string): string {
  return CANVAS[baseHex.toLowerCase()] ?? baseHex;
}

/** Ink as an sRGB triple, for gates that composite against it. */
export function inkRgb(): [number, number, number] {
  return hexToRgb(INK).rgb;
}

/**
 * Resolve the hue names an authored card cites into the colour slices the
 * ground renderer draws with.
 *
 * `kit` defaults to Colony's own, which is what the app renders its own cards
 * with. A customer's stored kit (kind 30198) is passed in instead, and that is
 * the whole point of the record: until this took a parameter, a derived kit
 * changed nothing about what was drawn.
 *
 * This is the one place Colony's ramp positions are interpreted: the kit
 * stores solved stops in the order {@link COLONY_RAMP} names, and this maps
 * them onto night (white-type safe) or dawn (ink-type safe) slices. The two
 * bright `free` stops a night card needs are not stored on the kit because
 * nothing may sit under type there; they are solved from the base on demand
 * by the same bisection.
 */
export function resolveGroundHues(
  family: GroundFamily,
  hues: string[],
  kit: BrandKit = COLONY_KIT,
): ResolvedGroundHue[] {
  return hues.map((name) => {
    const entry = kit.hues.find((hue) => hue.name === name);
    if (!entry) {
      throw new Error(
        `brand kit ${kit.id}: no hue named ${name}. It has ${kit.hues
          .map((hue) => hue.name)
          .join(", ")}`,
      );
    }
    const stop = (index: number): string => {
      const value = entry.ramp[index];
      if (!value) {
        throw new Error(
          `brand kit ${kit.id}: hue ${name} has ${entry.ramp.length} ramp ` +
            `stops, and the ground needs stop ${index}. A kit whose ramp was ` +
            `sampled rather than solved does not carry the named positions ` +
            `COLONY_RAMP reads.`,
        );
      }
      return value;
    };
    if (family === "night") {
      return {
        base: entry.base,
        free: [solveWhiteOn(entry.base, 4.2), solveWhiteOn(entry.base, 3.4)],
        lift: "rgba(255,255,255,.26)",
        name,
        safe: [
          stop(COLONY_RAMP.nightSafe0),
          stop(COLONY_RAMP.nightSafe1),
          stop(COLONY_RAMP.nightSafe2),
        ],
      };
    }
    return {
      base: entry.base,
      free: ["#ffffff", canvasLightTint(entry.base)],
      lift: "rgba(255,255,255,.92)",
      name,
      safe: [
        stop(COLONY_RAMP.dawnSafe0),
        stop(COLONY_RAMP.dawnSafe1),
        stop(COLONY_RAMP.dawnSafe2),
      ],
    };
  });
}
