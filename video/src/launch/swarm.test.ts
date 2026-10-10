import assert from "node:assert/strict";
import { test } from "node:test";
import { mulberry32 } from "./math.ts";
import type { Point } from "./points.ts";
import { antState, createAnts, type Lane } from "./swarm.ts";

const lanes: Lane[] = [
  { c1: { x: -100, y: 1000 }, c2: { x: 100, y: 300 }, spread: 80 },
  { c1: { x: 1180, y: 1000 }, c2: { x: 980, y: 300 }, spread: 80 },
];

function points(n: number, seed: number, cx: number, cy: number): Point[] {
  const r = mulberry32(seed);
  return Array.from({ length: n }, () => ({
    x: cx + (r() - 0.5) * 600,
    y: cy + (r() - 0.5) * 300,
  }));
}

const starts = points(200, 1, 540, 960);
const ends = points(200, 2, 540, 800);
const opts = { seed: 7, releaseAt: 2, sweep: 0.45, frameWidth: 1080 };

test("createAnts is deterministic", () => {
  assert.deepEqual(
    createAnts(starts, ends, lanes, opts),
    createAnts(starts, ends, lanes, opts),
  );
});

test("every start and every end is used exactly once", () => {
  const ants = createAnts(starts, ends, lanes, opts);
  assert.equal(ants.length, 200);
  assert.equal(new Set(ants.map((a) => a.start)).size, 200);
  assert.equal(new Set(ants.map((a) => a.end)).size, 200);
});

test("refuses mismatched point sets", () => {
  assert.throws(
    () => createAnts(starts, ends.slice(1), lanes, opts),
    /199 ends/,
  );
});

test("each river stays inside its lane spread", () => {
  for (const ant of createAnts(starts, ends, lanes, opts)) {
    const lane = lanes[ant.group];
    assert.ok(Math.abs(ant.c1.x - lane.c1.x) <= lane.spread);
    assert.ok(Math.abs(ant.c2.y - lane.c2.y) <= lane.spread);
  }
});

test("an ant sits on its letter before release and on the logo after landing", () => {
  for (const ant of createAnts(starts, ends, lanes, opts).slice(0, 20)) {
    const before = antState(ant, ant.release - 0.01);
    assert.equal(before.x, ant.start.x);
    assert.equal(before.y, ant.start.y);
    assert.equal(before.toGroup, 0);
    const after = antState(ant, ant.release + ant.duration + 0.5);
    assert.ok(Math.abs(after.x - ant.end.x) < 1e-6);
    assert.ok(Math.abs(after.y - ant.end.y) < 1e-6);
    assert.equal(after.toViolet, 1);
    assert.ok(Math.abs(after.angle) < 1e-9);
  }
});

test("ants are invisible before they appear", () => {
  const ant = createAnts(starts, ends, lanes, opts)[0];
  assert.equal(antState(ant, ant.appear - 0.01).alpha, 0);
  assert.equal(antState(ant, ant.appear + 0.2).alpha, 1);
});

test("no ant teleports between neighbouring moments", () => {
  for (const ant of createAnts(starts, ends, lanes, opts).slice(0, 40)) {
    let prev = antState(ant, ant.release - 0.05);
    for (
      let t = ant.release - 0.05;
      t < ant.release + ant.duration + 0.05;
      t += 1 / 240
    ) {
      const next = antState(ant, t);
      assert.ok(
        Math.hypot(next.x - prev.x, next.y - prev.y) < 40,
        `jump at t=${t}`,
      );
      prev = next;
    }
  }
});
