import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorAt } from "../launch/app/cursorPath.ts";
import {
  draftsReady,
  EMAIL_CARD,
  emailTypedAt,
  MAX_LINE_CHARS,
} from "../launch/wide/email.ts";
import { approveKeys } from "./approve.ts";
import {
  EP04,
  EP04_BEATS,
  EP04_CALL,
  EP04_EMAIL,
  EP04_LINES,
  EP04_REPLY,
  EP04_SECONDS,
  REPLY_NOTE,
  YES_FROM,
} from "./ep04.ts";
import { assertEpisodeShape } from "./episodeChecks.test.ts";
import { HANDOFF_APPROVE, HANDOFF_CARD } from "./handoff.ts";

const spoken = (id: string) => {
  const l = EP04_LINES.find((x) => x.id === id);
  if (!l) throw new Error(`no line ${id}`);
  return l.speech;
};

test("episode 4 keeps the season's shared rules", () => {
  assertEpisodeShape({
    seconds: EP04_SECONDS,
    beats: EP04_BEATS,
    lines: EP04_LINES,
    hook: {
      wordsAt: EP04.hookWordsAt,
      swarmFrom: EP04.swarmFrom,
      stageFrom: EP04.stageFrom,
      stageTo: EP04.stageTo,
    },
    avatarAt: EP04.avatarAt,
    click: EP04.click,
    close: { dimFrom: EP04.closeFrom, urlAt: EP04.urlAt },
    doneAt: EP04.approvedAt,
  });
});

test("the email to the venue is written while 'It writes to wedding venues' is said", () => {
  const [start, end] = spoken("w1");
  for (const l of EP04_EMAIL.lines) {
    assert.ok(l.length <= MAX_LINE_CHARS, `"${l}" overflows`);
  }
  assert.ok(EP04.typeFrom >= start && EP04.typeFrom <= start + 0.6);
  assert.ok(emailTypedAt(EP04, EP04_EMAIL.lines) <= end + 1.2);
  const counted = EP04.countRushFrom + EP04.countRush;
  assert.equal(draftsReady(counted, EP04, EP04_EMAIL.lines), 20);
  assert.ok(
    counted <= EP04.replyAt,
    "drafts still counting when the reply comes",
  );
});

test("the reply arrives on 'When one replies', under the email", () => {
  const [start, end] = spoken("w2");
  assert.ok(EP04.replyAt >= start && EP04.replyAt <= end + 0.3);
  assert.ok(EP04.sentAt <= EP04.replyAt, "reply to a draft");
  assert.ok(EP04_REPLY.text.split(" ").length <= 7);
  const lastLineBottom = EMAIL_CARD.y + 404 + 3 * 50 + 12 + 50;
  assert.ok(REPLY_NOTE.y >= lastLineBottom + 12, "reply covers the email");
  assert.ok(REPLY_NOTE.y + REPLY_NOTE.h <= EMAIL_CARD.y + EMAIL_CARD.h - 12);
});

test("the call starts on 'It calls' and the meeting is booked once both sides are heard", () => {
  const [start] = spoken("w3");
  const [yesStart] = spoken("y1");
  assert.ok(EP04.callIn >= start - 0.1 && EP04.callIn <= start + 0.4);
  const heard = (text: string, at: number) => at + text.split(" ").length / 7;
  assert.ok(heard(EP04_CALL.lines[0].text, EP04.bubble1At) <= EP04.bubble2At);
  assert.ok(
    heard(EP04_CALL.lines[1].text, EP04.bubble2At) + 0.6 <= EP04.bookedAt,
  );
  assert.ok(EP04.bookedAt + 1.0 <= yesStart, "booking not seen before the yes");
  assert.equal(EP04_CALL.booked, "Meeting booked: Fri 11:00");
});

test("the next emails wait under the employee and Approve is clicked on 'yes'", () => {
  const [start] = spoken("y1");
  assert.ok(EP04.yesCardIn <= start && EP04.approveIn <= start + 0.2);
  assert.ok(HANDOFF_CARD.y + HANDOFF_CARD.h <= 940);
  const b = HANDOFF_APPROVE;
  const keys = approveKeys(
    b,
    { cursorFrom: EP04.cursorFrom, click: EP04.click },
    YES_FROM,
  );
  for (const t of [EP04.click - 0.1, EP04.click, EP04.click + 0.3]) {
    const p = cursorAt(keys, t);
    assert.ok(
      p.x > b.x + 8 &&
        p.x < b.x + b.w - 8 &&
        p.y > b.y + 8 &&
        p.y < b.y + b.h - 8,
      `at ${t}`,
    );
  }
});
