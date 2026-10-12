import assert from "node:assert/strict";
import { test } from "node:test";
import { EP06, EP06_LINES, EP06_REQUEST } from "./ep06.ts";
import {
  BAR_H,
  NEW_TILES,
  PAGE_H,
  REQUEST_BUBBLE,
  wipeY,
} from "./ep06Phone.ts";
import { linesAt, PHONE_CARD, PINNED } from "./phone.ts";

const speech = (id: string) => {
  const l = EP06_LINES.find((x) => x.id === id);
  if (!l) throw new Error(id);
  return l.speech;
};
const buttonTop = PINNED.y - PHONE_CARD.y - 30;

test("the page fills the card under the browser bar", () => {
  assert.equal(BAR_H + PAGE_H, PHONE_CARD.h);
});

test("your request fits its bubble and is typed while the voice says it", () => {
  const lines = linesAt(EP06_REQUEST, 30, REQUEST_BUBBLE.w - 48);
  assert.ok(lines <= 3, `${lines} lines`);
  assert.ok(52 + lines * 39 + 24 <= REQUEST_BUBBLE.h);
  const w1 = speech("w1");
  assert.ok(EP06.requestFrom >= w1[0] && EP06.requestFrom <= w1[1]);
  const end = EP06.requestFrom + EP06_REQUEST.length / EP06.requestCps;
  assert.ok(end <= EP06.paintFrom, "the painting starts before you finish");
});

test("the painter repaints the whole page, top to bottom, as the voice says it updates the page", () => {
  assert.equal(wipeY(EP06.paintFrom, EP06), 0);
  assert.equal(wipeY(EP06.paintFrom + EP06.paintDuration, EP06), PAGE_H);
  for (let f = 0; f < 60; f++) {
    const a = wipeY(EP06.paintFrom + (f / 60) * EP06.paintDuration, EP06);
    const b = wipeY(EP06.paintFrom + ((f + 1) / 60) * EP06.paintDuration, EP06);
    assert.ok(b >= a);
  }
  const w2 = speech("w2");
  assert.ok(EP06.paintFrom >= w2[0] - 0.2 && EP06.paintFrom <= w2[1]);
  assert.ok(EP06.beforeFrom >= w2[0] && EP06.beforeFrom <= w2[1] + 0.5);
});

test("the new price and the Saturday hours stay in view above the pinned button", () => {
  for (const tile of NEW_TILES) {
    assert.ok(BAR_H + tile.top + tile.h <= buttonTop, `${tile.label}`);
  }
});
