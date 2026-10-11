import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BEAT,
  BEAT_SECONDS,
  BEAT_VOICE,
  carryPath,
  foundCount,
  LEADS,
  ownerSlot,
} from "./beat.ts";

test("every carrier walks to its own row", () => {
  LEADS.forEach((_, i) => {
    const end = carryPath(i)[3];
    const slot = ownerSlot(i);
    assert.equal(end.x, slot.x);
    assert.equal(end.y, slot.y);
  });
});

test("every carrier arrives before the second voice line", () => {
  const last = LEADS.length - 1;
  const arrives = BEAT.carryFrom + last * BEAT.carryEvery + BEAT.carryDuration;
  assert.ok(arrives <= BEAT_VOICE[1].at, `last carrier lands at ${arrives}`);
});

test("the found counter starts at 0, never goes down and ends at 20", () => {
  assert.equal(foundCount(0), 0);
  let prev = 0;
  for (let t = 0; t <= BEAT_SECONDS; t += 1 / 30) {
    const n = foundCount(t);
    assert.ok(n >= prev, `counter went down at ${t}`);
    prev = n;
  }
  assert.equal(foundCount(BEAT_SECONDS), 20);
});

test("voice lines fit the beat and never overlap", () => {
  for (const line of BEAT_VOICE) {
    assert.ok(line.speech[0] >= 0 && line.speech[1] <= BEAT_SECONDS);
  }
  assert.ok(BEAT_VOICE[1].speech[0] >= BEAT_VOICE[0].speech[1]);
});
