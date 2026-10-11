import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorAt } from "../launch/app/cursorPath.ts";
import { approveKeys } from "./approve.ts";
import {
  EP07,
  EP07_BEATS,
  EP07_DRAFT,
  EP07_LINES,
  EP07_QUEUE,
  EP07_SECONDS,
  NOTE_BOX,
  REVIEW_APPROVE,
  REVIEW_CARD,
  queueRowAt,
} from "./ep07.ts";
import { assertEpisodeShape } from "./episodeChecks.test.ts";

const spoken = (id: string) => {
  const l = EP07_LINES.find((x) => x.id === id);
  if (!l) throw new Error(`no line ${id}`);
  return l.speech;
};

test("episode 7 keeps the season's shared rules", () => {
  assertEpisodeShape({
    seconds: EP07_SECONDS,
    beats: EP07_BEATS,
    lines: EP07_LINES,
    hook: {
      wordsAt: EP07.hookWordsAt,
      swarmFrom: EP07.swarmFrom,
      stageFrom: EP07.stageFrom,
      stageTo: EP07.stageTo,
    },
    avatarAt: EP07.avatarAt,
    click: EP07.click,
    close: { dimFrom: EP07.closeFrom, urlAt: EP07.urlAt },
    doneAt: EP07.sentAt,
  });
});

test("the work queues up for the owner while 'everything comes to you first' is said", () => {
  const [start, end] = spoken("m1");
  assert.equal(EP07_QUEUE.length, 3);
  EP07_QUEUE.forEach((row, i) => {
    assert.ok(row.title.length <= 26, `"${row.title}" overflows`);
    const at = queueRowAt(i, EP07);
    assert.ok(at >= start + 2.4 && at <= end, `row ${i} at ${at}`);
  });
});

test("the quote reply opens on 'Here's a reply'", () => {
  const [start] = spoken("w1");
  assert.ok(EP07.openAt >= start - 0.1 && EP07.openAt <= start + 0.4);
});

test("the owner's note is typed while it is said", () => {
  const [start, end] = spoken("w2");
  const typedBy = EP07.noteFrom + EP07_DRAFT.note.length / EP07.noteCps;
  assert.ok(EP07.noteFrom >= start + 2.0 && typedBy <= end + 0.2);
  assert.ok(NOTE_BOX.y >= REVIEW_CARD.y + 540, "note covers the draft");
});

test("the rewrite comes in seconds, shorter, with the supplies, beside the old one", () => {
  const [start] = spoken("w3");
  const [yesStart] = spoken("y1");
  assert.ok(EP07.rewriteAt >= start && EP07.rewriteAt <= start + 0.3);
  const typedBy = EP07.rewriteAt + EP07_DRAFT.after.length / EP07.rewriteCps;
  assert.ok(typedBy <= yesStart - 0.5, "rewrite still typing at the yes");
  assert.ok(EP07_DRAFT.after.length <= EP07_DRAFT.before.length * 0.6);
  assert.ok(EP07_DRAFT.after.includes("bring our own supplies"));
});

test("Approve is clicked on 'yes' and the email goes on 'it goes'", () => {
  const [y2Start, y2End] = spoken("y2");
  assert.ok(
    NOTE_BOX.y + NOTE_BOX.h + 12 <= REVIEW_APPROVE.y,
    "button on the note",
  );
  const b = REVIEW_APPROVE;
  const keys = approveKeys(b, EP07);
  for (const t of [EP07.click - 0.1, EP07.click, EP07.click + 0.3]) {
    const p = cursorAt(keys, t);
    assert.ok(
      p.x > b.x + 8 &&
        p.x < b.x + b.w - 8 &&
        p.y > b.y + 8 &&
        p.y < b.y + b.h - 8,
      `at ${t}`,
    );
  }
  assert.ok(EP07.sentAt >= y2Start + 1.0 && EP07.sentAt <= y2End);
});
