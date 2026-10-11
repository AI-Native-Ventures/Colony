import assert from "node:assert/strict";
import { test } from "node:test";
import { CALL, callSeconds } from "./call.ts";

const timing = {
  callIn: 10,
  connectAt: 10.8,
  bubble1At: 11.1,
  bubble2At: 12.5,
  bookedAt: 13.5,
};

test("the sales call pitches ongoing work to a builder, not a repair", () => {
  assert.equal(CALL.company, "Atlas Construction");
  const said = CALL.lines.map((l) => l.text).join(" ");
  assert.match(said, /Bright Plumbing/);
  assert.match(said, /building sites/);
  assert.doesNotMatch(said, /leak|burst|fix your/i);
});

test("the call ends with a booked meeting", () => {
  assert.match(CALL.booked, /^Meeting booked/);
});

test("the call timer starts at 0:00 when the call connects and counts up", () => {
  assert.equal(callSeconds(timing.callIn, timing), 0);
  assert.equal(callSeconds(timing.connectAt, timing), 0);
  assert.ok(callSeconds(timing.connectAt + 2, timing) > 0);
  let prev = 0;
  for (let t = timing.connectAt; t < timing.bookedAt + 2; t += 1 / 30) {
    const s = callSeconds(t, timing);
    assert.ok(s >= prev);
    prev = s;
  }
});
