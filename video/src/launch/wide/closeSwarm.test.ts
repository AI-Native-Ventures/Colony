import assert from "node:assert/strict";
import { test } from "node:test";
import type { Point } from "../points.ts";
import { DAY_END, dayAntSpot } from "./day.ts";
import { TEAM } from "./employees.ts";
import { CLOSE_LOGO, CLOSE90 } from "./film90.ts";
import { closeSwarmAnts, GROUP_OF } from "./closeSwarm.ts";

function logoGrid(): Point[] {
  const out: Point[] = [];
  for (let y = 0; y < CLOSE_LOGO.height; y += 6) {
    for (let x = 0; x < CLOSE_LOGO.width; x += 6) {
      out.push({
        x: CLOSE_LOGO.cx - CLOSE_LOGO.width / 2 + x,
        y: CLOSE_LOGO.cy - CLOSE_LOGO.height / 2 + y,
      });
    }
  }
  return out;
}

const ants = closeSwarmAnts(logoGrid());

test("every ant lands in the logo as it appears", () => {
  for (const ant of ants) {
    const lands = ant.release + ant.duration;
    assert.ok(lands >= CLOSE90.logoIn - 0.5, `early at ${lands}`);
    assert.ok(lands <= CLOSE90.logoIn + 0.45, `late at ${lands}`);
    assert.ok(Math.abs(ant.end.x - CLOSE_LOGO.cx) <= CLOSE_LOGO.width / 2);
    assert.ok(Math.abs(ant.end.y - CLOSE_LOGO.cy) <= CLOSE_LOGO.height / 2);
  }
});

test("each employee's ants leave from where that employee walked the day", () => {
  TEAM.forEach((who, k) => {
    const mine = ants.filter((a) => a.group === GROUP_OF[who]);
    assert.ok(mine.length > 0, `${who} has no ants`);
    const home = dayAntSpot(k, DAY_END);
    for (const ant of mine) {
      assert.ok(Math.hypot(ant.start.x - home.x, ant.start.y - home.y) <= 60);
    }
  });
});

test("each employee builds its own part of the logo, left to right like the opening", () => {
  const order = ["blue", "amber", "green", "pink"] as const;
  const meanX = order.map((who) => {
    const mine = ants.filter((a) => a.group === GROUP_OF[who]);
    return mine.reduce((sum, a) => sum + a.end.x, 0) / mine.length;
  });
  for (let i = 1; i < meanX.length; i++) assert.ok(meanX[i] > meanX[i - 1]);
});

test("the close swarm is the same every time", () => {
  assert.deepEqual(closeSwarmAnts(logoGrid()), ants);
});
