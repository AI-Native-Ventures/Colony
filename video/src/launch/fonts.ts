import { loadFont } from "@remotion/google-fonts/Inter";

const inter = loadFont("normal", {
  weights: ["500", "600", "700", "800"],
  subsets: ["latin"],
});

/** The family name to use in CSS and canvas font strings. */
export const INTER = inter.fontFamily;
export const interReady: Promise<unknown> = inter.waitUntilDone();
