import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorAt } from "../launch/app/cursorPath.ts";
import { foundCount, landsAt, tickRect } from "../launch/wide/beat.ts";
import { type Rect, restKeys, tickKeys } from "./approve.ts";
import {
  EP03,
  EP03_BEATS,
  EP03_LEADS,
  EP03_LINES,
  EP03_PICKS,
  EP03_REQUEST,
  EP03_SECONDS,
} from "./ep03.ts";
import { assertEpisodeShape } from "./episodeChecks.test.ts";
import {
  CHIP,
  chipLands,
  HANDOFF_APPROVE,
  HANDOFF_CARD,
  slotSpot,
} from "./handoff.ts";

const spoken = (id: string) => {
  const l = EP03_LINES.find((x) => x.id === id);
  if (!l) throw new Error(`no line ${id}`);
  return l.speech;
};

const inside = (p: { x: number; y: number }, b: Rect) =>
  p.x > b.x + 6 && p.x < b.x + b.w - 6 && p.y > b.y + 6 && p.y < b.y + b.h - 6;

test("episode 3 keeps the season's shared rules", () => {
  assertEpisodeShape({
    seconds: EP03_SECONDS,
    beats: EP03_BEATS,
    lines: EP03_LINES,
    hook: {
      wordsAt: EP03.hookWordsAt,
      swarmFrom: EP03.swarmFrom,
      stageFrom: EP03.stageFrom,
      stageTo: EP03.stageTo,
    },
    avatarAt: EP03.avatarAt,
    close: { dimFrom: EP03.closeFrom, urlAt: EP03.urlAt },
    doneAt: EP03.restAt,
  });
});

test("the request is typed while 'office parks in Sandton' is said", () => {
  const [start, end] = spoken("w1");
  const typedBy = EP03.requestFrom + EP03_REQUEST.length / EP03.requestCps;
  assert.ok(EP03.requestFrom >= start + 1.2 && typedBy <= end + 0.6);
});

test("seven leads land and the count reaches twenty while the search is described", () => {
  const [start, end] = spoken("w2");
  assert.equal(EP03_LEADS.length, 7);
  EP03_LEADS.forEach((lead, i) => {
    assert.ok(lead.name.length <= 21, `"${lead.name}" overflows`);
    const why = lead.why ?? "";
    assert.ok(why.length > 0 && why.length <= 24, `"${why}" overflows`);
    const at = landsAt(i, EP03);
    assert.ok(at >= start && at <= end, `lead ${i} lands at ${at}`);
  });
  const full = EP03.countRushFrom + EP03.countRush;
  assert.equal(foundCount(full, EP03, EP03_LEADS.length), 20);
  assert.ok(full <= end);
});

test("the reasons appear on 'with why each one fits'", () => {
  const [start, end] = spoken("w2");
  assert.ok(EP03.reasonsAt >= start + 3.0);
  assert.ok(EP03.reasonsAt + 6 * EP03.reasonsEvery + 0.4 <= end);
});

test("the owner ticks five, the pointer on each box as it clicks", () => {
  const [start, end] = spoken("w3");
  assert.equal(EP03_PICKS.length, 5);
  const boxes = EP03_PICKS.map((p) => tickRect(p.row));
  const clicks = EP03_PICKS.map((p) => p.at);
  assert.ok(clicks[0] >= start && clicks[4] <= end + 0.6);
  assert.ok(
    EP03_PICKS.every(
      (p) => EP03.reasonsAt + p.row * EP03.reasonsEvery + 0.4 < p.at,
    ),
  );
  const keys = tickKeys(boxes, clicks, EP03.tickCursorFrom);
  boxes.forEach((b, i) => {
    assert.ok(inside(cursorAt(keys, clicks[i]), b), `tick ${i}`);
  });
});

test("the picks slide to the sales employee while 'writes to them next' is said", () => {
  const [start, end] = spoken("y1");
  assert.ok(EP03.heroUntil + 0.35 <= EP03.amberAvatarAt, "blue still there");
  assert.ok(Math.abs(EP03.amberAvatarAt - start) <= 0.2);
  assert.ok(
    EP03.handoffIn + 0.5 <= EP03.chipFrom,
    "chips land before the card",
  );
  EP03_PICKS.forEach((_, k) => {
    const at = chipLands(k, EP03);
    assert.ok(at >= start && at <= end + 0.6, `chip ${k} lands at ${at}`);
    assert.ok(
      slotSpot(k).x + CHIP / 2 <= HANDOFF_APPROVE.x - 12,
      "chip under Approve",
    );
  });
});

test("Approve waits under the pointer while 'Nothing goes out without your yes' is said", () => {
  const [start, end] = spoken("y2");
  assert.ok(Math.abs(EP03.approveIn - start) <= 0.2);
  assert.ok(EP03.restAt <= end);
  const keys = restKeys(HANDOFF_APPROVE, EP03);
  for (const t of [EP03.restAt, EP03.closeFrom]) {
    assert.ok(inside(cursorAt(keys, t), HANDOFF_APPROVE), `at ${t}`);
  }
  assert.ok(HANDOFF_CARD.y + HANDOFF_CARD.h <= 940, "card runs into captions");
});
