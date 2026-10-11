import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyLineTop, draftsReady, EMAIL, MAX_LINE_CHARS } from "./email.ts";

test("every email line fits the card", () => {
  for (const line of EMAIL.lines) {
    assert.ok(line.length <= MAX_LINE_CHARS, `"${line}" is too long`);
  }
});

test("the email greets Thabo at Grayston Office Park", () => {
  assert.equal(EMAIL.lines[0], "Hi Thabo,");
  assert.equal(EMAIL.company, "Grayston Office Park");
});

test("the email offers a partnership, not a one-off repair", () => {
  const body = EMAIL.lines.join(" ");
  assert.match(body, /on-call plumber/);
  assert.match(body, /contract/);
  assert.match(body, /meet/);
  assert.doesNotMatch(`${EMAIL.subject} ${body}`, /leak|burst|fix your/i);
});

test("body lines go down the card without touching", () => {
  for (let i = 1; i < EMAIL.lines.length; i++) {
    assert.ok(bodyLineTop(i) - bodyLineTop(i - 1) >= 46);
  }
});

const timing = {
  typeFrom: 10,
  typeCps: 55,
  returnSeconds: 0.3,
  countRushFrom: 15.5,
  countRush: 0.6,
};

test("no drafts are ready while the email is still being typed", () => {
  assert.equal(draftsReady(10.5, timing), 0);
});

test("drafts ready goes 0, then 1, then up to 20, never down", () => {
  let prev = 0;
  let sawOne = false;
  for (let t = 9; t <= 17; t += 1 / 30) {
    const n = draftsReady(t, timing);
    assert.ok(n >= prev, `went down at ${t}`);
    if (n === 1) sawOne = true;
    prev = n;
  }
  assert.ok(sawOne, "never showed Thabo's draft on its own");
  assert.equal(prev, 20);
});
