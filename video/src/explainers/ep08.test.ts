import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorAt } from "../launch/app/cursorPath.ts";
import { approveKeys } from "./approve.ts";
import {
  EP08,
  EP08_BEATS,
  EP08_LINES,
  EP08_REPLY,
  EP08_SECONDS,
} from "./ep08.ts";
import { assertEpisodeShape } from "./episodeChecks.test.ts";
import {
  CHAT_APPROVE,
  CHAT_CARD,
  MENU_AFTER,
  MENU_BEFORE,
  THREAD,
  THREAD_VIEW_H,
  THREADS,
} from "./thandi.ts";

const spoken = (id: string) => {
  const l = EP08_LINES.find((x) => x.id === id);
  if (!l) throw new Error(`no line ${id}`);
  return l.speech;
};

test("episode 8 keeps the season's shared rules", () => {
  assertEpisodeShape({
    seconds: EP08_SECONDS,
    beats: EP08_BEATS,
    lines: EP08_LINES,
    hook: {
      wordsAt: EP08.hookWordsAt,
      swarmFrom: EP08.swarmFrom,
      stageFrom: EP08.stageFrom,
      stageTo: EP08.stageTo,
    },
    avatarAt: EP08.avatarAt,
    click: EP08.click,
    close: { dimFrom: EP08.closeFrom, urlAt: EP08.urlAt },
    doneAt: EP08.approvedAt,
  });
});

test("each chat lights up as its topic is named", () => {
  const [start, end] = spoken("w1");
  assert.deepEqual(
    THREADS.map((th) => th.name),
    ["Weddings", "Office lunches", "Website"],
  );
  EP08.threadsAt.forEach((at, i) => {
    assert.ok(at >= start + 2.0 && at <= end, `chat ${i} at ${at}`);
    if (i > 0) assert.ok(at - EP08.threadsAt[i - 1] >= 0.5);
  });
  assert.ok(EP08.cardIn + 1.1 <= start, "chats not up before they are named");
});

test("the owner's reply is typed on the menu while it is said", () => {
  const [start, end] = spoken("w2");
  const typedBy = EP08.replyFrom + EP08_REPLY.length / EP08.replyCps;
  assert.ok(EP08.replyIn >= start + 0.8 && EP08.replyIn <= EP08.replyFrom);
  assert.ok(EP08.replyFrom >= start + 2.2 && typedBy <= end + 0.4);
});

test("the new menu comes back in the same thread, vegetarian in every course", () => {
  const [start] = spoken("w3");
  const [yesStart] = spoken("y1");
  assert.ok(EP08.backAt >= start && EP08.backAt <= start + 0.4);
  assert.ok(
    yesStart - (EP08.backAt + 0.9) >= 2.0,
    "new menu not up long enough",
  );
  assert.equal(MENU_AFTER.length, MENU_BEFORE.length);
  for (const c of MENU_AFTER) {
    assert.ok(
      c.dishes.some((d) => d.veg),
      `${c.course} has no vegetarian dish`,
    );
  }
  assert.ok(MENU_BEFORE.every((c) => c.dishes.every((d) => !d.veg)));
  const menuBottom = THREAD.secondMenu.y + THREAD.secondMenu.h;
  assert.ok(menuBottom - THREAD.scroll <= THREAD_VIEW_H, "new menu cut off");
  assert.ok(THREAD.reply.y - THREAD.scroll >= 0, "reply scrolled away");
});

test("Approve is clicked on 'yes', the pointer on it", () => {
  const b = CHAT_APPROVE;
  assert.ok(b.y + b.h <= CHAT_CARD.y + CHAT_CARD.h - 12);
  assert.ok(EP08.approveIn >= EP08.backAt + 0.9);
  const keys = approveKeys(b, EP08);
  for (const t of [EP08.click - 0.1, EP08.click, EP08.click + 0.3]) {
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
