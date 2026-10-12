import assert from "node:assert/strict";
import { test } from "node:test";
import { clearOfCovers, insideFeed } from "../launch/tall/frame.ts";
import { breakLines, CARD_BOX, CHAT_BOX, planInterview } from "./plan.ts";
import { SCOUT_INTERVIEW } from "./scout.ts";

const plan = planInterview(SCOUT_INTERVIEW);

test("every line starts after the one before it ends, with room to breathe", () => {
  for (let i = 1; i < plan.lines.length; i++)
    assert.ok(
      plan.lines[i].at >= plan.lines[i - 1].end + 0.25,
      `${plan.lines[i].id} starts ${plan.lines[i].at}, before ${plan.lines[i - 1].end} + 0.25`,
    );
});

test("questions and answers take turns, and each answer has its own question", () => {
  const speakers = plan.lines.map((l) => l.speaker);
  for (let i = 1; i < speakers.length; i++)
    assert.notEqual(speakers[i], speakers[i - 1], `line ${i}`);
  for (const pair of plan.pairs) {
    assert.equal(pair.question.speaker, "you");
    if (pair.answer) {
      assert.equal(pair.answer.speaker, "scout");
      assert.ok(pair.answer.at > pair.question.end);
    }
  }
});

test("the stamp lands on 'You're hired.' and the end card waits for it", () => {
  const last = plan.lines[plan.lines.length - 1];
  assert.equal(last.text, "You're hired.");
  assert.ok(plan.stampAt >= last.at && plan.stampAt <= last.end + 0.1);
  assert.ok(plan.close.dimFrom >= plan.stampAt + 1.2);
  assert.ok(plan.close.urlAt + 1 <= plan.seconds);
});

test("the episode runs about 20 seconds", () => {
  assert.ok(plan.seconds >= 17 && plan.seconds <= 24, `${plan.seconds}`);
});

test("the candidate card and the chat stay clear of what Instagram draws over a Reel, and inside the feed preview", () => {
  for (const box of [CARD_BOX, CHAT_BOX]) {
    assert.ok(clearOfCovers(box), JSON.stringify(box));
    assert.ok(insideFeed(box), JSON.stringify(box));
  }
  assert.ok(CARD_BOX.y + CARD_BOX.h <= CHAT_BOX.y);
});

test("a bubble's words break into lines no wider than the bubble allows, and the bubble hugs the longest", () => {
  const width = (s: string) => s.length * 10;
  const lines = breakLines(
    "I can't send anything without your yes.".split(" "),
    width,
    250,
  );
  assert.deepEqual(lines, ["I can't send anything", "without your yes."]);
  for (const line of lines) assert.ok(width(line) <= 250, line);
});

test("a word longer than the bubble still gets a line of its own", () => {
  const width = (s: string) => s.length * 10;
  assert.deepEqual(breakLines(["a", "enormousword", "b"], width, 60), [
    "a",
    "enormousword",
    "b",
  ]);
});
