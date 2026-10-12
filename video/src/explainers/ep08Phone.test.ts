import assert from "node:assert/strict";
import { test } from "node:test";
import { EP08, EP08_LINES, EP08_REPLY } from "./ep08.ts";
import {
  inThreadView,
  LIST,
  PUSH_AT,
  PUSH_SECONDS,
  TAP_AT,
  THREAD_PHONE as TH,
  THREAD_VIEW,
  threadScroll,
} from "./ep08Phone.ts";
import { PHONE_CARD, PINNED } from "./phone.ts";

const speech = (id: string) => {
  const l = EP08_LINES.find((x) => x.id === id);
  if (!l) throw new Error(id);
  return l.speech;
};

test("each topic's chat is in the list and lit while its name is said", () => {
  const w1 = speech("w1");
  EP08.threadsAt.forEach((at, i) => {
    assert.ok(at >= w1[0] && at <= w1[1], `topic ${i}`);
    assert.ok(LIST.top + i * LIST.step + LIST.h <= PHONE_CARD.h - 40);
  });
});

test("the tap into Weddings comes after the last topic and the thread is open as the reply line starts", () => {
  assert.ok(TAP_AT >= EP08.threadsAt[2] + 0.3);
  assert.ok(PUSH_AT >= TAP_AT);
  assert.ok(PUSH_AT + PUSH_SECONDS <= speech("w2")[0] + 0.3);
});

test("the reply is wholly in view while it is typed", () => {
  const end = EP08.replyFrom + EP08_REPLY.length / EP08.replyCps;
  for (let f = Math.ceil(EP08.replyIn * 30); f <= end * 30; f++) {
    assert.ok(inThreadView(TH.reply.y, TH.reply.h, f / 30), `at ${f / 30}`);
  }
});

test("the new menu comes back wholly in view during its line and stays clear of the pinned button", () => {
  const w3 = speech("w3");
  for (let f = Math.ceil((w3[0] + 1) * 30); f <= (EP08.click + 1) * 30; f++) {
    const t = f / 30;
    assert.ok(inThreadView(TH.menu2.y, TH.menu2.h, t), `at ${t}`);
  }
  const bottom =
    THREAD_VIEW.top + TH.menu2.y + TH.menu2.h - threadScroll(EP08.click);
  assert.ok(bottom <= PINNED.y - PHONE_CARD.y - 30, `menu bottom ${bottom}`);
});

test("the thread never scrolls past its first or last message", () => {
  const max =
    TH.menu2.y + TH.menu2.h - (THREAD_VIEW.bottom - THREAD_VIEW.top) + 200;
  for (let f = 0; f <= 34 * 30; f++) {
    const y = threadScroll(f / 30);
    assert.ok(y >= 0 && y <= max, `${y}`);
  }
});
