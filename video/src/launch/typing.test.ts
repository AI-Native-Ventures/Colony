import assert from "node:assert/strict";
import { test } from "node:test";
import { typedText } from "./typing.ts";

const full = "brightplumbing.co.za";

test("nothing is typed before the start", () => {
  assert.equal(typedText(full, 9.8, 9.9, 14), "");
  assert.equal(typedText(full, 9.9, 9.9, 14), "");
});

test("everything is typed once enough time has passed", () => {
  assert.equal(typedText(full, 9.9 + full.length / 14 + 0.01, 9.9, 14), full);
  assert.equal(typedText(full, 99, 9.9, 14), full);
});

test("typing only ever grows, one prefix at a time", () => {
  let prev = "";
  for (let t = 9.9; t < 12; t += 1 / 30) {
    const now = typedText(full, t, 9.9, 14);
    assert.ok(full.startsWith(now), `"${now}" is not a prefix`);
    assert.ok(now.length >= prev.length, "typing went backwards");
    prev = now;
  }
});
