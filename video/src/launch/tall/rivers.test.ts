import assert from "node:assert/strict";
import { test } from "node:test";
import { antState } from "../swarm.ts";
import { TEAM, TONES } from "../wide/employees.ts";
import { TIMING90, YES90 } from "../wide/film90.ts";
import { riverAnts } from "../wide/riverAnts.ts";
import { PHONE_CARD } from "../../explainers/phone.ts";
import { approvedAt, YES_ROWS } from "../wide/yes.ts";
import { TALL_H, TALL_W } from "./frame.ts";
import {
  FILM_COMPACT_AT,
  filmPlanAvatar,
  INBOX_ROWS,
  inboxRowTop,
} from "./filmPages.ts";
import { heroAvatarAt } from "./hero.ts";
import { TALL_BURSTS, TALL_RIVERS } from "./rivers.ts";
import { panelY, scrollY } from "./scroll.ts";

test("each employee's river lands on its avatar, where the avatar is when it lands, at the film's times", () => {
  for (const id of TEAM) {
    const river = TALL_RIVERS[id];
    const at = heroAvatarAt(river.landAt, FILM_COMPACT_AT[id]);
    assert.deepEqual(river.target, { x: at.x, y: panelY(id) + at.y }, id);
    assert.equal(river.startAt, TIMING90[id].riverFrom, id);
    assert.equal(river.landAt, TIMING90[id].avatarAt, id);
    assert.equal(river.color, TONES[id].rgb, id);
  }
});

test("blue's river leaves Scout's plan from the blue job's avatar on the phone card", () => {
  const node = filmPlanAvatar(0);
  const { from } = TALL_RIVERS.blue;
  assert.equal((from.x0 + from.x1) / 2, node.x);
  assert.equal((from.y0 + from.y1) / 2, panelY("scout") + node.y);
});

test("blue's river stays on the screen while the page scrolls under it", () => {
  const spec = TALL_RIVERS.blue;
  const ants = riverAnts(spec);
  for (let f = Math.round(spec.startAt * 30); f <= spec.landAt * 30; f++) {
    const t = f / 30;
    const top = scrollY(t);
    const seen = ants.filter((ant) => antState(ant, t).alpha > 0.05);
    const on = seen.filter((ant) => {
      const s = antState(ant, t);
      return s.x >= 0 && s.x <= TALL_W && s.y >= top && s.y <= top + TALL_H;
    });
    assert.ok(
      on.length >= 0.95 * seen.length,
      `${on.length}/${seen.length} at ${t}`,
    );
  }
});

test("the other rivers start off the screen, so no ant appears from nothing", () => {
  for (const id of ["amber", "pink", "green"] as const) {
    const { from, startAt } = TALL_RIVERS[id];
    const top = scrollY(startAt - 0.5);
    const bottom = scrollY(startAt) + TALL_H;
    const outside =
      from.x1 < 0 || from.x0 > TALL_W || from.y1 < top || from.y0 > bottom;
    assert.ok(outside, `${id} starts on screen`);
  }
});

test("on Approve, each inbox row's work streams out of its phone row past the right edge", () => {
  assert.equal(TALL_BURSTS.length, YES_ROWS.length);
  const page = panelY("yes");
  TALL_BURSTS.forEach((burst, i) => {
    const top = page + PHONE_CARD.y + inboxRowTop(i);
    assert.ok(
      burst.from.x0 >= PHONE_CARD.x + INBOX_ROWS.textLeft &&
        burst.from.x1 <= PHONE_CARD.x + PHONE_CARD.w - 40,
      `row ${i} x`,
    );
    assert.ok(
      burst.from.y0 >= top && burst.from.y1 <= top + INBOX_ROWS.h,
      `row ${i} y`,
    );
    assert.ok(burst.target.x > TALL_W, `row ${i} stays on screen`);
    assert.equal(burst.startAt, approvedAt(i, YES90) + 0.02);
    assert.equal(burst.color, TONES[YES_ROWS[i].who].rgb);
  });
});
