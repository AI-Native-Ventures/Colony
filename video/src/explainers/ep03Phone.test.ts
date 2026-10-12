import assert from "node:assert/strict";
import { test } from "node:test";
import { landsAt } from "../launch/wide/beat.ts";
import { EP03, EP03_LEADS, EP03_LINES, EP03_PICKS } from "./ep03.ts";
import {
  LEAD_ROWS,
  PICK_ROWS,
  pickLandsAt,
  PUSH_AT,
  PUSH_SECONDS,
  restCursorKeys,
  tickBox,
  tickCursorKeys,
} from "./ep03Phone.ts";
import { PHONE_CARD, PINNED } from "./phone.ts";

const speech = (id: string) => {
  const l = EP03_LINES.find((x) => x.id === id);
  if (!l) throw new Error(id);
  return l.speech;
};
const buttonTop = PINNED.y - PHONE_CARD.y - 30;
const inside = (
  p: { x: number; y: number },
  b: { x: number; y: number; w: number; h: number },
) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;

test("the seven leads fit the card under the request", () => {
  const last =
    LEAD_ROWS.top + (EP03_LEADS.length - 1) * LEAD_ROWS.step + LEAD_ROWS.h;
  assert.ok(last <= PHONE_CARD.h - 20, `rows end at ${last}`);
  assert.ok(LEAD_ROWS.top >= 124 + 52 + 39 + 12);
});

test("the leads arrive as the voice says it searches, and the picks are ticked as it says you pick", () => {
  const w2 = speech("w2");
  EP03_LEADS.forEach((_, i) => {
    const at = landsAt(i, EP03);
    assert.ok(at >= w2[0] && at <= w2[1], `lead ${i}`);
  });
  const w3 = speech("w3");
  for (const p of EP03_PICKS) assert.ok(p.at >= w3[0] && p.at <= w3[1] + 0.5);
});

test("the pointer ticks each pick's box", () => {
  const keys = tickCursorKeys(EP03);
  for (const p of EP03_PICKS) {
    const key = keys.find((k) => Math.abs(k.at - (p.at - 0.1)) < 1e-9);
    assert.ok(key, `no key for row ${p.row}`);
    assert.ok(inside(key, tickBox(p.row)), `row ${p.row}`);
  }
});

test("the sales screen comes after the last pick, its five picks land as the voice says it writes to them, above the pinned button", () => {
  const last = EP03_PICKS[EP03_PICKS.length - 1].at;
  const y1 = speech("y1");
  assert.ok(PUSH_AT >= last + 0.3 && PUSH_AT + PUSH_SECONDS <= y1[0]);
  EP03_PICKS.forEach((_, k) => {
    const at = pickLandsAt(k, EP03);
    assert.ok(at >= y1[0] && at <= y1[1], `pick ${k}`);
  });
  const bottom =
    PICK_ROWS.top + (EP03_PICKS.length - 1) * PICK_ROWS.step + PICK_ROWS.h;
  assert.ok(bottom <= buttonTop, `picks end at ${bottom}`);
});

test("the pointer comes to rest on Approve and never presses it", () => {
  const keys = restCursorKeys(EP03);
  const last = keys[keys.length - 1];
  assert.ok(inside(last, PINNED));
  assert.ok(last.at <= speech("y2")[1]);
});
