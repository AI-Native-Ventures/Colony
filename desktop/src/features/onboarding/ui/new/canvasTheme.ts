import type { OnboardingStep, OnboardingTrack } from "../../flow/steps";

/** Brand hues. Values verified against docs/BRAND.md. */
const HUE = {
  violet: "#8b5cf6",
  violetDeep: "#4c1d95",
  blue: "#3b82f6",
  pink: "#ec4899",
  pinkSoft: "#f9a8d4",
  amber: "#f59e0b",
  green: "#10b981",
  plum: "#6b1746",
  white: "#ffffff",
} as const;

export type MeshBlob = {
  color: string;
  x: string;
  y: string;
  radius: string;
};

export type CanvasTheme = {
  base: string;
  /** "dark" means dark ink on a light field. */
  ink: "dark" | "light";
  mesh: MeshBlob[];
};

const blob = (
  color: string,
  x: string,
  y: string,
  radius: string,
): MeshBlob => ({
  color,
  x,
  y,
  radius,
});

/**
 * One gradient per screen. The canvas shifting as the flow advances is the
 * progress indicator, which is why no step counter appears in the flow.
 *
 * Every screen is dark. The scene this is designed for is a founder at a
 * kitchen table at 9pm, laptop open, not yet sure this software is for them,
 * and on a dark field the colony glows rather than sitting on a pale card. It
 * is also a threshold: onboarding is deliberately not the app, and stepping
 * from here into the light workspace should feel like arriving somewhere.
 *
 * The base barely moves between screens. Character comes from which accent hue
 * leads the mesh, so the field drifts rather than jumping, and no screen reads
 * as a different product.
 */
const THEMES: Record<string, CanvasTheme> = {
  account: {
    base: "#191325",
    ink: "light",
    mesh: [
      blob(HUE.violet, "14%", "86%", "64%"),
      blob(HUE.blue, "88%", "12%", "56%"),
      blob(HUE.violetDeep, "52%", "48%", "34%"),
    ],
  },
  recovery: {
    base: "#181226",
    ink: "light",
    mesh: [
      blob(HUE.violetDeep, "14%", "86%", "64%"),
      blob(HUE.violet, "88%", "12%", "56%"),
      blob(HUE.plum, "52%", "48%", "34%"),
    ],
  },
  company: {
    base: "#1a1424",
    ink: "light",
    mesh: [
      blob(HUE.amber, "14%", "86%", "64%"),
      blob(HUE.violet, "88%", "12%", "56%"),
      blob(HUE.blue, "52%", "48%", "34%"),
    ],
  },
  probing: {
    base: "#161327",
    ink: "light",
    mesh: [
      blob(HUE.blue, "14%", "86%", "64%"),
      blob(HUE.violet, "88%", "12%", "56%"),
      blob(HUE.green, "52%", "48%", "34%"),
    ],
  },
  "brain:byo": {
    base: "#151527",
    ink: "light",
    mesh: [
      blob(HUE.green, "14%", "86%", "64%"),
      blob(HUE.blue, "88%", "12%", "56%"),
      blob(HUE.violet, "52%", "48%", "34%"),
    ],
  },
  "brain:colony": {
    base: "#141426",
    ink: "light",
    mesh: [
      blob(HUE.blue, "14%", "86%", "64%"),
      blob(HUE.violetDeep, "88%", "12%", "56%"),
      blob(HUE.violet, "52%", "48%", "34%"),
    ],
  },
  business: {
    base: "#1a1523",
    ink: "light",
    mesh: [
      blob(HUE.amber, "14%", "86%", "64%"),
      blob(HUE.pink, "88%", "12%", "56%"),
      blob(HUE.violet, "52%", "48%", "34%"),
    ],
  },
  reading: {
    base: "#151628",
    ink: "light",
    mesh: [
      blob(HUE.green, "14%", "86%", "64%"),
      blob(HUE.blue, "88%", "12%", "56%"),
      blob(HUE.violetDeep, "52%", "48%", "34%"),
    ],
  },
  description: {
    base: "#1a1327",
    ink: "light",
    mesh: [
      blob(HUE.pink, "14%", "86%", "64%"),
      blob(HUE.violet, "88%", "12%", "56%"),
      blob(HUE.blue, "52%", "48%", "34%"),
    ],
  },
  credits: {
    base: "#1b1129",
    ink: "light",
    mesh: [
      blob(HUE.violet, "14%", "86%", "64%"),
      blob(HUE.plum, "88%", "12%", "56%"),
      blob(HUE.pink, "52%", "48%", "34%"),
    ],
  },
  invite: {
    base: "#181329",
    ink: "light",
    mesh: [
      blob(HUE.violet, "14%", "86%", "64%"),
      blob(HUE.pink, "88%", "12%", "56%"),
      blob(HUE.blue, "52%", "48%", "34%"),
    ],
  },
};

export function canvasFor(
  step: OnboardingStep,
  track: OnboardingTrack,
): CanvasTheme {
  if (step === "brain") return THEMES[`brain:${track}`];
  return THEMES[step];
}
