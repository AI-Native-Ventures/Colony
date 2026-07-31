// site/src/brand/palette.ts
// Standalone copy of desktop/src/shared/ui/colony-logo/palette.ts. The site
// package cannot import desktop source, so this file is kept in sync by hand
// against docs/BRAND.md, the source of truth for these values.

/** Colony brand hues. Violet leads; the rest are accent hues used by the
 * landing scatter field and marketing surfaces. Values are the brand source
 * of truth (mirrored in docs/BRAND.md). */
export const COLONY_VIOLET = "hsl(258 90% 66%)";
export const COLONY_BLUE = "hsl(217 91% 60%)";
export const COLONY_PINK = "hsl(330 81% 60%)";
export const COLONY_AMBER = "hsl(38 92% 50%)";
export const COLONY_GREEN = "hsl(160 60% 45%)";

export const COLONY_HUES = [
  COLONY_VIOLET,
  COLONY_BLUE,
  COLONY_PINK,
  COLONY_AMBER,
  COLONY_GREEN,
];
