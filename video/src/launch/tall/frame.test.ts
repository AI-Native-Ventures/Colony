import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAPTION_BOX,
  CARD_BOX,
  COVERED,
  clearOfCovers,
  HERO_BOX,
  insideFeed,
  PANEL_CARD,
  TALL_H,
  TALL_W,
  toTall,
} from "./frame.ts";

test("the employee row, the card and the captions stay clear of Instagram's covers", () => {
  for (const b of [HERO_BOX, CARD_BOX, CAPTION_BOX]) {
    assert.ok(clearOfCovers(b), JSON.stringify(b));
  }
});

test("a box under the like and comment buttons is not clear", () => {
  assert.equal(clearOfCovers({ x: 900, y: 1200, w: 100, h: 50 }), false);
  assert.equal(clearOfCovers({ x: 58, y: 1600, w: 100, h: 50 }), false);
  assert.equal(clearOfCovers({ x: 58, y: 100, w: 100, h: 50 }), false);
});

test("the employee row and the card sit inside the feed's 4:5 band", () => {
  assert.ok(insideFeed(HERO_BOX) && insideFeed(CARD_BOX));
});

test("a film card's corners land on the tall card box", () => {
  const a = toTall(PANEL_CARD);
  const b = toTall({ x: PANEL_CARD.x + 940, y: PANEL_CARD.y + 760 });
  assert.deepEqual(a, { x: CARD_BOX.x, y: CARD_BOX.y });
  assert.ok(Math.abs(b.x - (CARD_BOX.x + CARD_BOX.w)) < 1e-9);
  assert.ok(Math.abs(b.y - (CARD_BOX.y + CARD_BOX.h)) < 1e-9);
});

test("the boxes stack top to bottom without touching", () => {
  assert.ok(HERO_BOX.y + HERO_BOX.h <= CARD_BOX.y);
  assert.ok(CARD_BOX.y + CARD_BOX.h + 20 <= CAPTION_BOX.y);
  assert.ok(CAPTION_BOX.y + CAPTION_BOX.h <= TALL_H - COVERED.bottom);
  assert.ok(CARD_BOX.x + CARD_BOX.w <= TALL_W);
});

test("captions are centred on the frame", () => {
  assert.equal(CAPTION_BOX.x + CAPTION_BOX.w / 2, TALL_W / 2);
});
