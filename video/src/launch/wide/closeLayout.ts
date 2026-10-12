import { WIDE_H, WIDE_W } from "./beat.ts";
import { CLOSE_LOGO } from "./film90.ts";

/** The close's words, top to bottom under the logo. */
export const CLOSE_WORDS = {
  name: "Colony.",
  tagline: "AI employees for your business.",
  early: "Early access is open",
  address: "colony.global",
} as const;

/** Where the close lands the logo on its frame, and how big it sets the name and the line. */
export type CloseLayout = {
  w: number;
  h: number;
  logo: { cx: number; cy: number; width: number; height: number };
  name: number;
  tagline: number;
};

/** The wide film's close. */
export const WIDE_CLOSE: CloseLayout = {
  w: WIDE_W,
  h: WIDE_H,
  logo: CLOSE_LOGO,
  name: 140,
  tagline: 50,
};

type Row = { x: number; y: number; w: number; h: number };

/** Inter's normal line height, in em. */
const LINE = 1.21;

/**
 * The rows under the logo as the close lays them out, estimated for tests
 * (0.6 em a character for the name, 0.55 for the words, 0.58 for the address).
 */
export function closeRows(
  layout: CloseLayout,
): Record<"name" | "tagline" | "early" | "address", Row> {
  const L = layout.logo;
  const row = (y: number, w: number, h: number): Row => ({
    x: layout.w / 2 - w / 2,
    y,
    w,
    h,
  });
  const name = row(
    L.cy + L.height / 2 + 26,
    CLOSE_WORDS.name.length * 0.6 * layout.name,
    layout.name * 1.05,
  );
  const tagline = row(
    name.y + name.h + 14,
    CLOSE_WORDS.tagline.length * 0.55 * layout.tagline,
    layout.tagline * LINE,
  );
  const early = row(
    tagline.y + tagline.h + 54,
    CLOSE_WORDS.early.length * 0.55 * 32,
    32 * LINE,
  );
  const address = row(
    early.y + early.h + 18,
    CLOSE_WORDS.address.length * 0.58 * 44 + 80,
    84,
  );
  return { name, tagline, early, address };
}
