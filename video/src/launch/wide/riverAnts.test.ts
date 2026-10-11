import assert from "node:assert/strict";
import { test } from "node:test";
import { type RiverSpec, riverAnts } from "./riverAnts.ts";

const spec: RiverSpec = {
  color: "rgb(1 2 3)",
  seed: 5,
  count: 80,
  from: { x0: 1960, x1: 2240, y0: 1120, y1: 1260 },
  lane: { c1: { x: 1350, y: 600 }, c2: { x: 600, y: 60 }, spread: 120 },
  target: { x: 200, y: 292 },
  startAt: 10,
  landAt: 11,
  sweep: 0,
  flight: { min: 0.9, spread: 0.3 },
};

test("a river is the same every time", () => {
  assert.deepEqual(riverAnts(spec), riverAnts(spec));
});

test("no river ant leaves before the river starts", () => {
  for (const ant of riverAnts(spec)) {
    assert.ok(ant.release >= spec.startAt - 1e-9, `left at ${ant.release}`);
  }
});

test("every river ant lands by the time the river fades", () => {
  for (const ant of riverAnts(spec)) {
    const lands = ant.release + ant.duration;
    assert.ok(lands <= spec.landAt + 0.45, `landed at ${lands}`);
  }
});

test("every river ant lands inside the avatar", () => {
  for (const ant of riverAnts(spec)) {
    const d = Math.hypot(ant.end.x - spec.target.x, ant.end.y - spec.target.y);
    assert.ok(d <= 48, `landed ${d.toFixed(1)} px from the centre`);
  }
});
