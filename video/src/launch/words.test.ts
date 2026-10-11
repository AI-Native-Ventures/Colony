import assert from "node:assert/strict";
import { test } from "node:test";
import { T_RELEASE } from "./timeline.ts";
import { ENTER_SECONDS, JOB_WORDS } from "./words.ts";

function gap(i: number): number {
  return JOB_WORDS[i].at - JOB_WORDS[i - 1].at;
}

test("the first four jobs land slowly enough to read", () => {
  for (let i = 1; i < 4; i++) {
    assert.ok(
      gap(i) >= 0.45 - 1e-9,
      `"${JOB_WORDS[i].text}" lands ${gap(i).toFixed(2)} s after the one before`,
    );
  }
});

test("later jobs speed up but never blur together", () => {
  for (let i = 4; i < JOB_WORDS.length; i++) {
    assert.ok(gap(i) >= 0.2, `"${JOB_WORDS[i].text}" lands too fast`);
    assert.ok(gap(i) <= gap(i - 1) + 1e-9, `"${JOB_WORDS[i].text}" slows down`);
  }
});

test("the full tower holds still long enough to scan before it breaks", () => {
  const last = JOB_WORDS[JOB_WORDS.length - 1];
  const hold = T_RELEASE - (last.at + ENTER_SECONDS);
  assert.ok(hold >= 0.6, `tower holds only ${hold.toFixed(2)} s`);
});
