import assert from "node:assert/strict";
import { test } from "node:test";
import { TOWER_STACK, TOWER_WORDS } from "../wide/intro.ts";
import { COVERED, TALL_H, TALL_W } from "./frame.ts";
import { TALL_OPENING as L } from "./opening.ts";

const TOP = COVERED.top;
const BOTTOM = TALL_H - COVERED.bottom;

const inContent = (top: number, bottom: number) =>
  top >= TOP && bottom <= BOTTOM;

test("the tall opening uses the tall frame", () => {
  assert.equal(L.w, TALL_W);
  assert.equal(L.h, TALL_H);
});

test("a trade word sits in the middle, clear of Instagram's covers", () => {
  assert.ok(inContent(L.trade.top, L.trade.top + L.trade.size * 1.25));
});

test("the pile of jobs fits between the covers, even at full size", () => {
  const sizes = TOWER_WORDS.map((w) => w.size);
  let span = 0;
  for (let j = 1; j < sizes.length; j++) {
    span += ((sizes[j - 1] + sizes[j]) / 2) * TOWER_STACK.leading;
  }
  const top = L.tower.centerY - span / 2 - sizes[0] / 2;
  const bottom = L.tower.centerY + span / 2 + sizes[sizes.length - 1] / 2;
  assert.ok(inContent(top, bottom), `${top} to ${bottom}`);
  assert.ok(L.tower.maxWidth <= TALL_W - 2 * 58);
});

test("the logo, the name under it, the definition and the team fit between the covers", () => {
  const logoTop = L.logo.cy - L.logo.height / 2;
  const logoBottom = L.logo.cy + L.logo.height / 2;
  assert.ok(inContent(logoTop, logoBottom));
  // "Introducing", "Colony." and the tagline under the logo.
  assert.ok(inContent(logoBottom + 40, logoBottom + 40 + 264));
  // The logo glides up and shrinks to 45% for the definition.
  const small = (L.logo.height * 0.45) / 2;
  assert.ok(L.logo.cy + L.logoShift - small >= TOP);
  assert.ok(L.logo.cy + L.logoShift + small + 40 <= L.define.top);
  // Title, gap, three rows of body text.
  assert.ok(inContent(L.define.top, L.define.top + 125 + 26 + 3 * 62));
  assert.ok(L.define.top + 125 + 26 + 3 * 62 + 60 <= L.team.y - 42);
  assert.ok(inContent(L.team.y - 42, L.team.y + 42));
  assert.ok(L.define.width <= TALL_W - 2 * 58);
  assert.ok(L.w / 2 + 1.5 * L.team.gap + 42 <= TALL_W);
});

test("every swarm lane flies out of view before it comes back", () => {
  assert.equal(L.lanes.length, 4);
  for (const lane of L.lanes) {
    const out =
      lane.c1.x < 0 ||
      lane.c1.x > TALL_W ||
      lane.c1.y < 0 ||
      lane.c1.y > TALL_H;
    assert.ok(out, JSON.stringify(lane.c1));
  }
});
