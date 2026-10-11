import assert from "node:assert/strict";
import { test } from "node:test";
import { wordsShown } from "./karaoke.ts";

const text = "Twenty offices in Sandton that need a plumber";
const speech = [10, 14] as const;

test("no words before the voice starts, all words after it ends", () => {
  assert.equal(wordsShown(text, speech, 9.99), 0);
  assert.equal(wordsShown(text, speech, 14), 8);
  assert.equal(wordsShown(text, speech, 30), 8);
});

test("the first word appears as the voice starts", () => {
  assert.equal(wordsShown(text, speech, 10), 1);
});

test("words only ever accumulate", () => {
  let prev = 0;
  for (let t = 9.5; t < 14.5; t += 1 / 30) {
    const n = wordsShown(text, speech, t);
    assert.ok(n >= prev, `went back at ${t}`);
    prev = n;
  }
});

test("a word never shows before its share of the line has started", () => {
  const words = text.split(" ");
  const total = words.reduce((sum, w) => sum + w.length + 1, 0);
  let before = 0;
  words.forEach((word, i) => {
    const startsAt = speech[0] + (before / total) * (speech[1] - speech[0]);
    assert.ok(
      wordsShown(text, speech, startsAt - 0.01) <= i,
      `"${word}" early`,
    );
    before += word.length + 1;
  });
});
