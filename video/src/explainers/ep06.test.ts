import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorAt } from "../launch/app/cursorPath.ts";
import { SITE_CARD } from "../launch/wide/bright.ts";
import { approveKeys } from "./approve.ts";
import {
  BAR_APPROVE,
  BAR_TOGGLE,
  DOMAIN_END,
  EP06,
  EP06_BEATS,
  EP06_LINES,
  EP06_REQUEST,
  EP06_SECONDS,
  REQUEST_CARD,
  YES_FROM,
} from "./ep06.ts";
import { assertEpisodeShape } from "./episodeChecks.test.ts";
import { MO_NOW, MO_OLD } from "./mo.ts";

const spoken = (id: string) => {
  const l = EP06_LINES.find((x) => x.id === id);
  if (!l) throw new Error(`no line ${id}`);
  return l.speech;
};

test("episode 6 keeps the season's shared rules", () => {
  assertEpisodeShape({
    seconds: EP06_SECONDS,
    beats: EP06_BEATS,
    lines: EP06_LINES,
    hook: {
      wordsAt: EP06.hookWordsAt,
      swarmFrom: EP06.swarmFrom,
      stageFrom: EP06.stageFrom,
      stageTo: EP06.stageTo,
    },
    avatarAt: EP06.avatarAt,
    click: EP06.click,
    close: { dimFrom: EP06.closeFrom, urlAt: EP06.urlAt },
    doneAt: EP06.liveAt,
  });
});

test("the owner's change is typed while it is said, with the new price and Saturdays", () => {
  const [start, end] = spoken("w1");
  const typedBy = EP06.requestFrom + EP06_REQUEST.length / EP06.requestCps;
  assert.ok(EP06.requestFrom >= start + 1.1 && typedBy <= end);
  assert.ok(EP06_REQUEST.includes(MO_NOW.service));
  assert.ok(EP06_REQUEST.includes("Saturdays"));
  assert.notEqual(MO_OLD.service, MO_NOW.service);
  assert.ok(REQUEST_CARD.y >= 740 && REQUEST_CARD.y + REQUEST_CARD.h <= 940);
});

test("the page is repainted on 'It updates the page'", () => {
  const [start, end] = spoken("w2");
  assert.ok(EP06.paintFrom >= start && EP06.paintFrom <= start + 0.4);
  assert.ok(EP06.paintFrom + EP06.paintDuration <= end + 0.3);
});

test("before and after are shown once the paint is done, and after stays to be read", () => {
  const [yesStart] = spoken("y1");
  const painted = EP06.paintFrom + EP06.paintDuration;
  assert.ok(EP06.toggleIn >= painted);
  assert.ok(EP06.beforeFrom >= EP06.toggleIn + 0.3);
  assert.ok(EP06.beforeUntil - EP06.beforeFrom >= 1.0);
  assert.ok(yesStart - EP06.beforeUntil >= 2.0, "new page not up long enough");
});

test("Approve sits in the browser bar and the pointer is on it when it clicks; Live follows on 'live'", () => {
  const [, end] = spoken("y1");
  assert.ok(DOMAIN_END + 8 <= BAR_TOGGLE.x, "address runs into Before/After");
  assert.ok(BAR_TOGGLE.x + BAR_TOGGLE.w + 8 <= BAR_APPROVE.x);
  assert.ok(BAR_APPROVE.x + BAR_APPROVE.w <= SITE_CARD.x + SITE_CARD.w - 20);
  const b = BAR_APPROVE;
  const keys = approveKeys(b, EP06, YES_FROM);
  for (const t of [EP06.click - 0.1, EP06.click, EP06.click + 0.3]) {
    const p = cursorAt(keys, t);
    assert.ok(
      p.x > b.x + 8 &&
        p.x < b.x + b.w - 8 &&
        p.y > b.y + 6 &&
        p.y < b.y + b.h - 6,
      `at ${t}`,
    );
  }
  assert.ok(EP06.liveAt >= EP06.click + 0.4 && EP06.liveAt <= end);
});
