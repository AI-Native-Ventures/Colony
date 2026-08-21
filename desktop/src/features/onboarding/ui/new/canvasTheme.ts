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
 * Credits is the only dark screen: it is the ask, and the dark field is what
 * makes it land.
 */
const THEMES: Record<string, CanvasTheme> = {
  account: {
    base: "#e9d9fb",
    ink: "dark",
    mesh: [
      blob(HUE.violet, "18%", "22%", "58%"),
      blob(HUE.pinkSoft, "78%", "72%", "62%"),
      blob(HUE.white, "50%", "45%", "40%"),
    ],
  },
  recovery: {
    base: "#c4b0f5",
    ink: "dark",
    mesh: [
      blob(HUE.violet, "30%", "70%", "66%"),
      blob(HUE.violetDeep, "82%", "24%", "48%"),
      blob(HUE.white, "44%", "40%", "30%"),
    ],
  },
  company: {
    base: "#f7d9c4",
    ink: "dark",
    mesh: [
      blob(HUE.pink, "22%", "18%", "56%"),
      blob(HUE.amber, "76%", "76%", "64%"),
      blob(HUE.white, "52%", "42%", "36%"),
    ],
  },
  probing: {
    base: "#cfe4f7",
    ink: "dark",
    mesh: [
      blob(HUE.blue, "24%", "26%", "62%"),
      blob(HUE.green, "80%", "74%", "58%"),
      blob(HUE.white, "48%", "46%", "38%"),
    ],
  },
  "brain:byo": {
    base: "#c9edda",
    ink: "dark",
    mesh: [
      blob(HUE.green, "26%", "30%", "62%"),
      blob(HUE.blue, "82%", "80%", "46%"),
      blob(HUE.white, "52%", "44%", "40%"),
    ],
  },
  "brain:colony": {
    base: "#cbdcfa",
    ink: "dark",
    mesh: [
      blob(HUE.blue, "20%", "24%", "60%"),
      blob(HUE.violet, "80%", "76%", "58%"),
      blob(HUE.white, "50%", "46%", "36%"),
    ],
  },
  business: {
    base: "#f8dfb4",
    ink: "dark",
    mesh: [
      blob(HUE.amber, "24%", "72%", "62%"),
      blob(HUE.pinkSoft, "78%", "22%", "54%"),
      blob(HUE.white, "48%", "44%", "38%"),
    ],
  },
  reading: {
    base: "#c7e9e2",
    ink: "dark",
    mesh: [
      blob(HUE.green, "22%", "24%", "60%"),
      blob(HUE.blue, "78%", "72%", "60%"),
      blob(HUE.white, "50%", "48%", "36%"),
    ],
  },
  description: {
    base: "#f6e2ee",
    ink: "dark",
    mesh: [
      blob(HUE.white, "40%", "34%", "52%"),
      blob(HUE.pink, "80%", "76%", "56%"),
      blob(HUE.violet, "16%", "78%", "44%"),
    ],
  },
  credits: {
    base: "#3d0a2a",
    ink: "light",
    mesh: [
      blob(HUE.plum, "28%", "30%", "66%"),
      blob(HUE.violetDeep, "78%", "74%", "62%"),
      blob(HUE.pink, "62%", "18%", "34%"),
    ],
  },
  invite: {
    base: "#e6dafb",
    ink: "dark",
    mesh: [
      blob(HUE.violet, "22%", "26%", "58%"),
      blob(HUE.pink, "80%", "74%", "56%"),
      blob(HUE.white, "50%", "50%", "40%"),
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
