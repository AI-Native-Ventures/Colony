import assert from "node:assert/strict";
import { test } from "node:test";
import { PHONE_CARD } from "../../explainers/phone.ts";
import {
  CAPTION_BOX,
  COVERED,
  clearOfCovers,
  HERO_BOX,
  insideFeed,
  TALL_H,
  TALL_W,
} from "./frame.ts";

test("the employee row, the phone card and the captions stay clear of Instagram's covers", () => {
  for (const b of [HERO_BOX, PHONE_CARD, CAPTION_BOX]) {
    assert.ok(clearOfCovers(b), JSON.stringify(b));
  }
});

test("a box under the like and comment buttons is not clear", () => {
  assert.equal(clearOfCovers({ x: 900, y: 1200, w: 100, h: 50 }), false);
  assert.equal(clearOfCovers({ x: 58, y: 1600, w: 100, h: 50 }), false);
  assert.equal(clearOfCovers({ x: 58, y: 100, w: 100, h: 50 }), false);
});

test("the employee row and the phone card sit inside the feed's 4:5 band", () => {
  assert.ok(insideFeed(HERO_BOX) && insideFeed(PHONE_CARD));
});

test("the phone card sits above the captions, and the captions above Instagram's foot", () => {
  assert.ok(PHONE_CARD.y + PHONE_CARD.h + 20 <= CAPTION_BOX.y);
  assert.ok(CAPTION_BOX.y + CAPTION_BOX.h <= TALL_H - COVERED.bottom);
  assert.ok(PHONE_CARD.x + PHONE_CARD.w <= TALL_W);
});

test("captions are centred on the frame", () => {
  assert.equal(CAPTION_BOX.x + CAPTION_BOX.w / 2, TALL_W / 2);
});
