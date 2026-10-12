/**
 * The tall frame for Reels: 1080 x 1920, what Instagram draws over it, and
 * where the film's employee row, cards and captions go. The film's cards are
 * drawn in its 1920 x 1080 panel pixels; `toTall` and `PANEL_TRANSFORM` put
 * them here at 94%.
 */
export const TALL_W = 1080;
export const TALL_H = 1920;

export type Box = { x: number; y: number; w: number; h: number };

/** What Instagram draws over a Reel (third-party guides, 2026): keep text out. */
export const COVERED = {
  top: 250,
  bottom: 400,
  right: { x: 948, from: 1050, to: 1520 },
} as const;

/** What the feed shows before a tap: the middle 4:5 band. */
export const FEED_BAND = { top: 285, bottom: 1635 } as const;

export const CARD_SCALE = 0.94;

/** Where the film's 940 x 760 cards land. */
export const CARD_BOX: Box = {
  x: 58,
  y: 650,
  w: 940 * CARD_SCALE,
  h: 760 * CARD_SCALE,
};

/** The employee row, its one-line title and its subline. */
export const HERO_BOX: Box = { x: 58, y: 296, w: 964, h: 344 };

/** Captions: two rows at most, left of the like and comment buttons. */
export const CAPTION_BOX: Box = { x: 58, y: 1392, w: 882, h: 120 };

/** The film's card origin, in its 1920 x 1080 panel pixels. */
export const PANEL_CARD = { x: 860, y: 150 } as const;

/** A point in the film's panel pixels, in the tall frame. */
export function toTall(p: { x: number; y: number }): { x: number; y: number } {
  return {
    x: CARD_BOX.x + (p.x - PANEL_CARD.x) * CARD_SCALE,
    y: CARD_BOX.y + (p.y - PANEL_CARD.y) * CARD_SCALE,
  };
}

/** The CSS transform (origin 0 0) that puts a film panel's card layer where `toTall` says. */
export const PANEL_TRANSFORM = `translate(${CARD_BOX.x - PANEL_CARD.x * CARD_SCALE}px, ${CARD_BOX.y - PANEL_CARD.y * CARD_SCALE}px) scale(${CARD_SCALE})`;

/** Whether a box stays inside the frame and out of everything Instagram draws over it. */
export function clearOfCovers(b: Box): boolean {
  const inFrame =
    b.x >= 0 &&
    b.x + b.w <= TALL_W &&
    b.y >= COVERED.top &&
    b.y + b.h <= TALL_H - COVERED.bottom;
  const r = COVERED.right;
  const underButtons = b.x + b.w > r.x && b.y < r.to && b.y + b.h > r.from;
  return inFrame && !underButtons;
}

/** Whether a box shows in the feed's 4:5 preview. */
export function insideFeed(b: Box): boolean {
  return b.y >= FEED_BAND.top && b.y + b.h <= FEED_BAND.bottom;
}
