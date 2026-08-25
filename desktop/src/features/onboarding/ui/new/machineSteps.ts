// desktop/src/features/onboarding/ui/new/machineCanvas.ts
import { HUE_CANVAS, type CanvasTheme, type HueName } from "./canvasTheme";

/**
 * The machine-setup screens, in the order someone walks them.
 *
 * These are a separate sequence from ONBOARDING_STEPS: that flow asks about
 * the person and their company, this one sets up the computer in front of
 * them. They share the canvas, the ant field and the type scale, so the two
 * read as one product, but a person only ever walks one of them at a time and
 * numbering them together would promise screens they will never see.
 */
export const MACHINE_STEPS = ["identity", "backup", "setup", "config"] as const;

export type MachineStep = (typeof MACHINE_STEPS)[number];

/**
 * Colour marks where you are, so neighbouring screens never repeat. The
 * sequence starts on violet because the landing screen is the first thing
 * anyone sees of Colony and violet is the brand's own hue.
 */
const MACHINE_HUE: Record<MachineStep, HueName> = {
  identity: "violet",
  backup: "blue",
  setup: "amber",
  config: "green",
};

export function machineCanvasFor(step: MachineStep): CanvasTheme {
  const hue = MACHINE_HUE[step];
  return { base: HUE_CANVAS[hue], ink: "dark", hue };
}
