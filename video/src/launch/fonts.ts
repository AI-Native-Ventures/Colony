import { loadFont as loadAnton } from "@remotion/google-fonts/Anton";
import { loadFont as loadCaveat } from "@remotion/google-fonts/Caveat";
import { loadFont } from "@remotion/google-fonts/Inter";
import { loadFont as loadPoppins } from "@remotion/google-fonts/Poppins";

const inter = loadFont("normal", {
  weights: ["500", "600", "700", "800"],
  subsets: ["latin"],
});

/**
 * Bright Plumbing's own type, so its posts and website read as another
 * company's work rather than Colony's: Poppins for text, Anton for the tall
 * capitals plumbing posts use, Caveat for the handwritten note on the site.
 */
const poppins = loadPoppins("normal", {
  weights: ["400", "500", "600", "700", "800"],
  subsets: ["latin"],
});
const anton = loadAnton("normal", { weights: ["400"], subsets: ["latin"] });
const caveat = loadCaveat("normal", { weights: ["700"], subsets: ["latin"] });

/** The family name to use in CSS and canvas font strings. */
export const INTER = inter.fontFamily;
export const POPPINS = poppins.fontFamily;
export const ANTON = anton.fontFamily;
export const CAVEAT = caveat.fontFamily;
export const interReady: Promise<unknown> = inter.waitUntilDone();

/** Every face the film draws with. */
export const fontsReady: Promise<unknown> = Promise.all([
  interReady,
  poppins.waitUntilDone(),
  anton.waitUntilDone(),
  caveat.waitUntilDone(),
]);
