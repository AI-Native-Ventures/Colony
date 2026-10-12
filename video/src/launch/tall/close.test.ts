import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "../points.ts";
import { closeRows } from "../wide/closeLayout.ts";
import { closeSwarmAnts, GROUP_OF } from "../wide/closeSwarm.ts";
import { DAY_END } from "../wide/day.ts";
import { TEAM } from "../wide/employees.ts";
import { CLOSE90 } from "../wide/film90.ts";
import { TALL_CLOSE, TALL_CLOSE_SWARM } from "./close.ts";
import { tallDayAntSpot } from "./day.ts";
import {
  type Box,
  CAPTION_BOX,
  COVERED,
  clearOfCovers,
  insideFeed,
  TALL_H,
  TALL_W,
} from "./frame.ts";

const L = TALL_CLOSE.logo;

function logoGrid(): Point[] {
  const out: Point[] = [];
  for (let y = 0; y < L.height; y += 6) {
    for (let x = 0; x < L.width; x += 6) {
      out.push({ x: L.cx - L.width / 2 + x, y: L.cy - L.height / 2 + y });
    }
  }
  return out;
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

test("the logo, the name, the line, 'Early access is open' and the address sit in view, above the captions", () => {
  const boxes: Record<string, Box> = {
    logo: {
      x: L.cx - L.width / 2,
      y: L.cy - L.height / 2,
      w: L.width,
      h: L.height,
    },
    ...closeRows(TALL_CLOSE),
  };
  for (const [name, box] of Object.entries(boxes)) {
    assert.ok(clearOfCovers(box), `${name} is under Instagram's buttons`);
    assert.ok(insideFeed(box), `${name} leaves the feed crop`);
    assert.ok(!overlaps(box, CAPTION_BOX), `${name} runs into the captions`);
  }
});

const ants = closeSwarmAnts(logoGrid(), TALL_CLOSE_SWARM);

test("each employee's ants leave from where it walked the day down the page", () => {
  TEAM.forEach((who, k) => {
    const mine = ants.filter((a) => a.group === GROUP_OF[who]);
    assert.ok(mine.length > 0, `${who} has no ants`);
    const home = tallDayAntSpot(k, DAY_END);
    for (const ant of mine) {
      assert.ok(Math.hypot(ant.start.x - home.x, ant.start.y - home.y) <= 60);
    }
  });
});

test("every ant lands in the tall logo as it appears", () => {
  for (const ant of ants) {
    const lands = ant.release + ant.duration;
    assert.ok(lands >= CLOSE90.logoIn - 0.5, `early at ${lands}`);
    assert.ok(lands <= CLOSE90.logoIn + 0.45, `late at ${lands}`);
    assert.ok(Math.abs(ant.end.x - L.cx) <= L.width / 2);
    assert.ok(Math.abs(ant.end.y - L.cy) <= L.height / 2);
  }
});

test("the ants fly in view: every bend of every lane, give or take its spread, is on the visible frame", () => {
  for (const [who, lane] of Object.entries(TALL_CLOSE_SWARM.lanes)) {
    for (const p of [lane.c1, lane.c2]) {
      assert.ok(p.x - lane.spread >= 0 && p.x + lane.spread <= TALL_W, who);
      assert.ok(p.y - lane.spread >= COVERED.top, who);
      assert.ok(p.y + lane.spread <= TALL_H - COVERED.bottom, who);
    }
  }
});

test("each employee builds its own part of the logo, left to right like the opening", () => {
  const order = ["blue", "amber", "green", "pink"] as const;
  const meanX = order.map((who) => {
    const mine = ants.filter((a) => a.group === GROUP_OF[who]);
    return mine.reduce((sum, a) => sum + a.end.x, 0) / mine.length;
  });
  for (let i = 1; i < meanX.length; i++) assert.ok(meanX[i] > meanX[i - 1]);
});
