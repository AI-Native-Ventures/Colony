import assert from "node:assert/strict";
import { test } from "node:test";
import { stackY } from "../stack.ts";
import {
  INTRO,
  swarmFade,
  TOWER_MAX_WIDTH,
  TOWER_STACK,
  TOWER_WORDS,
  TRADE_WORDS,
  WIDE_LOGO_RECT,
} from "./intro.ts";

test("the tower of jobs fits inside the wide frame", () => {
  const sizes = TOWER_WORDS.map((w) => w.size);
  const ys = stackY(
    sizes,
    TOWER_WORDS.map((w) => w.at),
    INTRO.release,
    TOWER_STACK,
  );
  ys.forEach((y, i) => {
    assert.ok(
      y - sizes[i] / 2 >= 40,
      `${TOWER_WORDS[i].text} pokes out the top`,
    );
    assert.ok(
      y + sizes[i] / 2 <= 1040,
      `${TOWER_WORDS[i].text} pokes out the bottom`,
    );
  });
  assert.ok(TOWER_MAX_WIDTH <= 1500);
});

test("trade words stay up long enough to read", () => {
  for (let i = 1; i < TRADE_WORDS.length; i++) {
    assert.ok(TRADE_WORDS[i].at - TRADE_WORDS[i - 1].at >= 0.5);
  }
});

test("jobs pile up after the trades are gone", () => {
  assert.ok(TOWER_WORDS[0].at >= INTRO.tradesOut);
});

test("the first jobs come slowly enough to read, then speed up", () => {
  const gaps = TOWER_WORDS.slice(1).map((w, i) => w.at - TOWER_WORDS[i].at);
  assert.ok(gaps[0] >= 0.6 && gaps[1] >= 0.6, "first jobs too fast");
  assert.ok(gaps[gaps.length - 1] < gaps[0], "never speeds up");
});

test("the swarm leaves only after the last job has landed and trembled", () => {
  const last = TOWER_WORDS[TOWER_WORDS.length - 1].at;
  assert.ok(INTRO.tremble >= last + 0.6);
  assert.ok(INTRO.release > INTRO.tremble);
});

test("the logo lands 2.25 s after the break, like the approved opening", () => {
  assert.ok(Math.abs(INTRO.logoIn - (INTRO.release + 2.25)) < 1e-9);
});

test("the logo sits in the top half, leaving room for the name under it", () => {
  assert.ok(WIDE_LOGO_RECT.cy + WIDE_LOGO_RECT.height / 2 <= 560);
});

test("the swarm is gone once the logo has landed, so no ants fuzz its edge", () => {
  assert.equal(swarmFade(INTRO.logoIn - 0.3), 1);
  assert.equal(swarmFade(INTRO.logoIn + 0.5), 0);
  assert.equal(swarmFade(INTRO.tagline), 0);
});
