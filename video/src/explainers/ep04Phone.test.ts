import assert from "node:assert/strict";
import { test } from "node:test";
import { emailTypedAt } from "../launch/wide/email.ts";
import { EP04, EP04_CALL, EP04_EMAIL, EP04_LINES, EP04_REPLY } from "./ep04.ts";
import {
  CALL_PHONE,
  PHONE_BODY,
  phoneBodyLineTop,
  PUSH_AT,
  PUSH_SECONDS,
  REPLY_PHONE,
  SHEET,
} from "./ep04Phone.ts";
import { linesAt, PHONE_CARD, PHONE_PAD, PINNED } from "./phone.ts";

const speech = (id: string) => {
  const l = EP04_LINES.find((x) => x.id === id);
  if (!l) throw new Error(id);
  return l.speech;
};
const W = PHONE_CARD.w - 2 * PHONE_PAD;

test("each line of the email fits the card at the phone's body size, and the reply sits under it", () => {
  for (const text of EP04_EMAIL.lines) {
    assert.ok(text.length * 0.53 * PHONE_BODY.size <= W, text);
  }
  const last =
    phoneBodyLineTop(EP04_EMAIL.lines.length - 1) + PHONE_BODY.lineHeight;
  assert.ok(last + 54 <= REPLY_PHONE.top, "the pen ant runs into the reply");
  assert.ok(linesAt(EP04_REPLY.text, 30, W - 48) <= 2);
  assert.ok(REPLY_PHONE.top + REPLY_PHONE.h <= PHONE_CARD.h - 24);
});

test("the email is written as the voice says it, sent, and the reply comes with its line", () => {
  const w1 = speech("w1");
  assert.ok(EP04.typeFrom >= w1[0] && EP04.typeFrom <= w1[1]);
  assert.ok(emailTypedAt(EP04, EP04_EMAIL.lines) <= EP04.sentAt);
  const w2 = speech("w2");
  assert.ok(EP04.replyAt >= w2[0] && EP04.replyAt <= w2[1]);
});

test("the call screen pushes in as the voice says it calls", () => {
  const w3 = speech("w3");
  assert.ok(PUSH_AT >= w3[0] - 0.3 && PUSH_AT + PUSH_SECONDS <= w3[1]);
});

test("the call's words and the booking sit above the sheet, and the sheet's words above its button", () => {
  const usLines = linesAt(EP04_CALL.lines[0].text, 28, CALL_PHONE.bubbleW - 48);
  assert.ok(CALL_PHONE.usTop + usLines * 36 + 32 <= CALL_PHONE.themTop - 12);
  assert.ok(CALL_PHONE.themTop + 76 <= CALL_PHONE.bookedTop - 12);
  assert.ok(CALL_PHONE.bookedTop + CALL_PHONE.bookedH <= SHEET.top - 12);
  assert.ok(SHEET.subTop + 34 <= PINNED.y - PHONE_CARD.y - 8);
  assert.ok(EP04.bookedAt < EP04.yesCardIn, "the sheet covers nothing new");
});
