import assert from "node:assert/strict";
import { test } from "node:test";
import { factAt, teamRowAt } from "../launch/wide/how.ts";
import { EP02, EP02_FACTS, EP02_LINES } from "./ep02.ts";
import {
  FACT_ROWS,
  FIELD,
  PUSH_AT,
  PUSH_SECONDS,
  READ,
  readCursorKeys,
  SCOUT_ROW_TOP,
  TEAM,
} from "./ep02Phone.ts";
import { PHONE_CARD, PHONE_PAD, PINNED } from "./phone.ts";

const speech = (id: string) => {
  const l = EP02_LINES.find((x) => x.id === id);
  if (!l) throw new Error(id);
  return l.speech;
};
const buttonTop = PINNED.y - PHONE_CARD.y - 30;

test("the website field, Read website and the four facts fit the card, in that order", () => {
  assert.ok(FIELD.top + FIELD.h <= READ.top - 16);
  assert.ok(READ.top + READ.h <= FACT_ROWS.top - 40);
  const last =
    FACT_ROWS.top + (EP02_FACTS.length - 1) * FACT_ROWS.step + FACT_ROWS.h;
  assert.ok(last <= PHONE_CARD.h - 24, `facts end at ${last}`);
});

test("the website is read after it is pasted, and each fact shows as the voice says it", () => {
  assert.ok(EP02.readClick >= speech("w1")[1]);
  const w2 = speech("w2");
  EP02_FACTS.forEach((_, i) => {
    const at = factAt(i, EP02);
    assert.ok(at >= w2[0] && at <= w2[1], `fact ${i}`);
  });
});

test("the pointer taps Read website at the read click", () => {
  const key = readCursorKeys(EP02).find((k) => k.at === EP02.readClick - 0.15);
  assert.ok(key, "no key at the click");
  const x0 = PHONE_CARD.x + PHONE_PAD;
  const y0 = PHONE_CARD.y + READ.top;
  assert.ok(key.x > x0 && key.x < x0 + PHONE_CARD.w - 2 * PHONE_PAD);
  assert.ok(key.y > y0 && key.y < y0 + READ.h);
});

test("the team screen pushes in before the team is named, and the team and Scout sit above the pinned button", () => {
  assert.ok(PUSH_AT + PUSH_SECONDS <= teamRowAt(0, EP02));
  const last = TEAM.top + 3 * TEAM.step + TEAM.h;
  assert.ok(last <= SCOUT_ROW_TOP - 10);
  assert.ok(SCOUT_ROW_TOP + TEAM.h <= buttonTop);
  const w3 = speech("w3");
  for (let i = 0; i < 4; i++) {
    const at = teamRowAt(i, EP02);
    assert.ok(at >= w3[0] && at <= w3[1], `row ${i}`);
  }
  assert.ok(EP02.scoutAt >= w3[0] && EP02.scoutAt <= w3[1]);
});
