import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorAt } from "../launch/app/cursorPath.ts";
import { SCOUT_CARD, taskLandsAt } from "../launch/wide/scout.ts";
import { approveKeys } from "./approve.ts";
import {
  EP01,
  EP01_APPROVE,
  EP01_BEATS,
  EP01_LINES,
  EP01_REQUEST,
  EP01_SECONDS,
  EP01_TASKS,
} from "./ep01.ts";
import { assertEpisodeShape } from "./episodeChecks.test.ts";

const spoken = (id: string) => {
  const l = EP01_LINES.find((x) => x.id === id);
  if (!l) throw new Error(`no line ${id}`);
  return l.speech;
};

test("episode 1 keeps the season's shared rules", () => {
  assertEpisodeShape({
    seconds: EP01_SECONDS,
    beats: EP01_BEATS,
    lines: EP01_LINES,
    hook: {
      wordsAt: EP01.hookWordsAt,
      swarmFrom: EP01.swarmFrom,
      stageFrom: EP01.stageFrom,
      stageTo: EP01.stageTo,
    },
    avatarAt: EP01.avatarAt,
    click: EP01.click,
    close: { dimFrom: EP01.closeFrom, urlAt: EP01.urlAt },
    doneAt: EP01.approvedAt,
  });
});

test("the owner's sentence is typed while it is said", () => {
  const [start, end] = spoken("w1");
  const typedBy = EP01.requestFrom + EP01_REQUEST.length / EP01.requestCps;
  assert.ok(EP01.requestFrom >= start - 0.3 && typedBy <= end + 0.6);
});

test("Scout deals the three jobs while making the plan is described", () => {
  const [start, end] = spoken("w2");
  assert.equal(EP01_TASKS.length, 3);
  EP01_TASKS.forEach((task, i) => {
    assert.ok(task.text.length <= 30, `"${task.text}" overflows its card`);
    const lands = taskLandsAt(i, EP01);
    assert.ok(
      lands >= start && lands <= end + 0.3,
      `task ${i} lands at ${lands}`,
    );
  });
});

test("Scout checks the work while checking is described", () => {
  const [start, end] = spoken("w3");
  assert.ok(EP01.checkAt >= start && EP01.checkAt + 0.24 + 0.3 <= end + 0.3);
});

test("Approve sits inside the plan card and the pointer is on it when it clicks", () => {
  const b = EP01_APPROVE;
  assert.ok(
    b.x >= SCOUT_CARD.x + SCOUT_CARD.w / 2 &&
      b.x + b.w <= SCOUT_CARD.x + SCOUT_CARD.w - 40,
  );
  assert.ok(b.y + b.h <= SCOUT_CARD.y + SCOUT_CARD.h - 24);
  const keys = approveKeys(b, EP01);
  for (const t of [EP01.click - 0.1, EP01.click, EP01.click + 0.3]) {
    const p = cursorAt(keys, t);
    assert.ok(
      p.x > b.x + 8 &&
        p.x < b.x + b.w - 8 &&
        p.y > b.y + 8 &&
        p.y < b.y + b.h - 8,
      `at ${t}`,
    );
  }
  assert.ok(EP01.approveIn < EP01.cursorFrom && EP01.approvedAt > EP01.click);
});
