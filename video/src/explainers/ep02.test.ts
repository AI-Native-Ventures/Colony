import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorAt } from "../launch/app/cursorPath.ts";
import {
  BUSINESS_CARD,
  factAt,
  READ_BUTTON,
  teamRowAt,
  WORKING_EVERY,
} from "../launch/wide/how.ts";
import { approveKeys } from "./approve.ts";
import {
  EP02,
  EP02_BEATS,
  EP02_FACTS,
  EP02_HIRE,
  EP02_LAYOUT,
  EP02_LINES,
  EP02_SECONDS,
  EP02_WEBSITE,
} from "./ep02.ts";
import { assertEpisodeShape } from "./episodeChecks.test.ts";

const spoken = (id: string) => {
  const l = EP02_LINES.find((x) => x.id === id);
  if (!l) throw new Error(`no line ${id}`);
  return l.speech;
};

test("episode 2 keeps the season's shared rules", () => {
  assertEpisodeShape({
    seconds: EP02_SECONDS,
    beats: EP02_BEATS,
    lines: EP02_LINES,
    hook: {
      wordsAt: EP02.hookWordsAt,
      swarmFrom: EP02.swarmFrom,
      stageFrom: EP02.stageFrom,
      stageTo: EP02.stageTo,
    },
    avatarAt: EP02.avatarAt,
    click: EP02.click,
    close: { dimFrom: EP02.closeFrom, urlAt: EP02.urlAt },
    doneAt: EP02.approvedAt + 3 * WORKING_EVERY,
  });
});

test("the website is pasted while 'Paste your website' is said", () => {
  const [start, end] = spoken("w1");
  assert.ok(EP02.pasteAt >= start && EP02.pasteAt <= end + 0.3);
  assert.ok(EP02_WEBSITE.length <= 24);
});

test("Read website is pressed on 'Colony reads it', the pointer on the button", () => {
  const [start] = spoken("w2");
  assert.ok(EP02.readClick >= start && EP02.readClick <= start + 1.0);
  const b = READ_BUTTON;
  const keys = approveKeys(b, {
    cursorFrom: EP02.cursorFrom,
    click: EP02.readClick,
  });
  const p = cursorAt(keys, EP02.readClick);
  assert.ok(
    p.x > b.x + 8 &&
      p.x < b.x + b.w - 8 &&
      p.y > b.y + 8 &&
      p.y < b.y + b.h - 8,
  );
});

test("what Colony read appears while it is said", () => {
  const [start, end] = spoken("w2");
  EP02_FACTS.forEach((_, i) => {
    const at = factAt(i, EP02);
    assert.ok(at >= start && at <= end, `fact ${i} at ${at}`);
  });
});

test("the card turns to the team on 'Then it hires your team', rows as they are named, Scout last", () => {
  const [start, end] = spoken("w3");
  assert.ok(
    EP02.continueClick >= start - 0.3 && EP02.continueClick <= start + 0.6,
  );
  for (let i = 0; i < 4; i++) {
    const at = teamRowAt(i, EP02);
    assert.ok(at >= start && at <= end, `row ${i} at ${at}`);
  }
  assert.ok(EP02.scoutAt > teamRowAt(3, EP02) && EP02.scoutAt <= end);
});

test("Hire my team sits under the team and the pointer is on it when it clicks", () => {
  const b = EP02_HIRE;
  const rowsEnd =
    BUSINESS_CARD.y + EP02_LAYOUT.top + 3 * EP02_LAYOUT.step + 104;
  assert.ok(b.y >= rowsEnd + 8, "Hire my team overlaps the last team row");
  assert.ok(
    EP02.approveIn >= EP02.scoutAt + 0.5,
    "button arrives while the team is still arriving",
  );
  assert.ok(b.y + b.h <= BUSINESS_CARD.y + BUSINESS_CARD.h - 16);
  const keys = approveKeys(b, {
    cursorFrom: EP02.yesCursorFrom,
    click: EP02.click,
  });
  for (const t of [EP02.click - 0.1, EP02.click, EP02.click + 0.3]) {
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
