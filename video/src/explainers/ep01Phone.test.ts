import assert from "node:assert/strict";
import { test } from "node:test";
import { taskLandsAt } from "../launch/wide/scout.ts";
import { EP01, EP01_LINES, EP01_REQUEST, EP01_TASKS } from "./ep01.ts";
import { NOTE_TOP, REQUEST_TOP, ROWS, TASK_TEXT_LEFT } from "./ep01Phone.ts";
import { linesAt, PHONE_CARD, PHONE_PAD, PINNED } from "./phone.ts";

const speech = (id: string) => {
  const l = EP01_LINES.find((x) => x.id === id);
  if (!l) throw new Error(id);
  return l.speech;
};
const buttonTop = PINNED.y - PHONE_CARD.y - 30;

test("the request, the jobs and Scout's note all sit above the pinned button", () => {
  const requestBottom =
    REQUEST_TOP +
    52 +
    linesAt(EP01_REQUEST, 30, PHONE_CARD.w - 2 * PHONE_PAD) * 39;
  assert.ok(requestBottom <= ROWS.top - 12, `request ends at ${requestBottom}`);
  const last = ROWS.top + (EP01_TASKS.length - 1) * ROWS.step + ROWS.h;
  assert.ok(last <= NOTE_TOP - 8);
  assert.ok(NOTE_TOP + 30 <= buttonTop);
});

test("each job's words fit on one line in its row", () => {
  for (const task of EP01_TASKS) {
    const width = task.text.length * 0.56 * 32;
    assert.ok(width <= PHONE_CARD.w - PHONE_PAD - TASK_TEXT_LEFT, task.text);
  }
});

test("the request is typed while the voice says it, the jobs land as Scout hands them out, the checks come with their line", () => {
  const w1 = speech("w1");
  assert.ok(EP01.requestFrom >= w1[0] && EP01.requestFrom <= w1[1]);
  const w2 = speech("w2");
  EP01_TASKS.forEach((_, i) => {
    const lands = taskLandsAt(i, EP01);
    assert.ok(lands >= w2[0] && lands <= w2[1] + 0.5, `job ${i}`);
  });
  const w3 = speech("w3");
  assert.ok(EP01.checkAt >= w3[0] && EP01.checkAt <= w3[1]);
});
