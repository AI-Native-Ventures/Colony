import type { Box } from "../launch/tall/frame.ts";

/**
 * The phone-style card every upright explainer draws its work in: centred,
 * under the slim header, above the big captions, left of Instagram's
 * buttons (owner, 2026-10-12: "Whole card = phone screen").
 */
export const PHONE_CARD: Box = { x: 140, y: 376, w: 800, h: 924 };

/** Space inside the card's edges. */
export const PHONE_PAD = 44;
