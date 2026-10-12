import assert from "node:assert/strict";
import { test } from "node:test";
import { TALL_H, TALL_W } from "../launch/tall/frame.ts";
import {
  EP07,
  EP07_DRAFT as D,
  EP07_LINES,
  EP07_QUEUE,
  queueRowAt,
} from "./ep07.ts";
import {
  AFTER,
  DRAFT,
  linesAt,
  PLANE,
  PUSH_AT,
  PUSH_SECONDS,
  QUEUE,
} from "./ep07Phone.ts";
import { PHONE_CARD, PHONE_PAD, PINNED } from "./phone.ts";

const speech = (id: string) => {
  const l = EP07_LINES.find((x) => x.id === id);
  if (!l) throw new Error(id);
  return l.speech;
};
const TEXT_W = PHONE_CARD.w - 2 * PHONE_PAD;
const buttonTop = PINNED.y - PHONE_CARD.y - 30;

test("the queue fills inside the card before the quote reply is opened", () => {
  EP07_QUEUE.forEach((_, i) => {
    assert.ok(QUEUE.top + i * QUEUE.step + QUEUE.h <= buttonTop);
    assert.ok(queueRowAt(i, EP07) < EP07.openAt);
  });
});

test("the reply opens as the voice introduces it", () => {
  const w1 = speech("w1");
  assert.ok(PUSH_AT >= EP07.openAt);
  assert.ok(PUSH_AT + PUSH_SECONDS <= w1[0] + 1);
});

test("the first draft and the note fit above the pinned button", () => {
  const draftLines = linesAt(D.before, 28, TEXT_W);
  assert.ok(DRAFT.bodyTop + draftLines * 28 * 1.45 <= DRAFT.noteTop - 16);
  assert.ok(linesAt(D.note, 28, TEXT_W - 48) <= 2);
  assert.ok(DRAFT.noteTop + DRAFT.noteH <= buttonTop);
});

test("the rewrite fits its block, under the first draft made small", () => {
  assert.ok(linesAt(D.after, 30, TEXT_W) * 30 * 1.45 + 52 <= AFTER.afterH);
  assert.ok(AFTER.beforeTop + AFTER.beforeH <= AFTER.afterTop);
  assert.ok(AFTER.afterTop + AFTER.afterH <= DRAFT.noteTop - 16);
});

test("the note is typed while the voice says it, and the rewrite while it says so", () => {
  const w2 = speech("w2");
  assert.ok(EP07.noteFrom >= w2[0] && EP07.noteFrom <= w2[1]);
  const w3 = speech("w3");
  assert.ok(EP07.rewriteAt >= w3[0] - 0.2 && EP07.rewriteAt <= w3[1]);
});

test("the sent email flies off the frame from the pinned button", () => {
  assert.ok(PLANE.from.x > PINNED.x && PLANE.from.x < PINNED.x + PINNED.w);
  assert.ok(PLANE.from.y > PINNED.y && PLANE.from.y < PINNED.y + PINNED.h);
  assert.ok(PLANE.to.x > TALL_W || PLANE.to.y < 0 || PLANE.to.y > TALL_H);
});
