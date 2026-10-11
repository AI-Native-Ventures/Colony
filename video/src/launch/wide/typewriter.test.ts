import assert from "node:assert/strict";
import { test } from "node:test";
import { typewriterAt, typewriterEnd } from "./typewriter.ts";

const lines = ["Hi Thabo,", "", "We fix leaks."];
const opts = { start: 10, cps: 20, returnSeconds: 0.3 };

test("nothing is typed before the start", () => {
  const s = typewriterAt(lines, 9.5, opts);
  assert.deepEqual(s.typed, ["", "", ""]);
  assert.equal(s.line, 0);
  assert.equal(s.returning, 0);
});

test("everything is typed after the end", () => {
  const s = typewriterAt(lines, typewriterEnd(lines, opts) + 0.01, opts);
  assert.deepEqual(s.typed, lines);
  assert.equal(s.done, true);
});

test("the first line types at the given speed", () => {
  const s = typewriterAt(lines, 10 + 4 / 20 + 0.001, opts);
  assert.equal(s.typed[0], "Hi T");
});

test("between lines the carriage returns while no text is added", () => {
  const lineDone = 10 + lines[0].length / 20;
  const mid = typewriterAt(lines, lineDone + 0.15, opts);
  assert.equal(mid.typed[0], lines[0]);
  assert.equal(mid.typed[2], "");
  assert.ok(
    mid.returning > 0 && mid.returning < 1,
    `returning ${mid.returning}`,
  );
});

test("typed text only ever grows", () => {
  let before = 0;
  for (let t = 9.9; t < typewriterEnd(lines, opts) + 0.2; t += 1 / 30) {
    const total = typewriterAt(lines, t, opts).typed.join("").length;
    assert.ok(total >= before, `went backwards at ${t}`);
    before = total;
  }
});
