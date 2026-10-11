import assert from "node:assert/strict";
import { test } from "node:test";
import { mulberry32 } from "../launch/math.ts";
import { edgeStarts } from "./swarmShape.ts";

const FRAME = { w: 1920, h: 1080 };
const side = (p: { x: number; y: number }) =>
  p.x < 0 ? "left" : p.x > FRAME.w ? "right" : p.y < 0 ? "top" : "bottom";

test("swarm ants start just outside the frame, on every side", () => {
  const pts = edgeStarts(400, mulberry32(7), FRAME);
  assert.equal(pts.length, 400);
  for (const p of pts) {
    const outside = p.x < 0 || p.x > FRAME.w || p.y < 0 || p.y > FRAME.h;
    assert.ok(outside, `(${p.x}, ${p.y}) is inside the frame`);
    assert.ok(
      p.x > -160 && p.x < FRAME.w + 160 && p.y > -160 && p.y < FRAME.h + 160,
    );
  }
  assert.equal(new Set(pts.map(side)).size, 4);
});

test("a swarm can be kept to some sides, clear of words on the left", () => {
  const pts = edgeStarts(
    300,
    mulberry32(9),
    FRAME,
    ["top", "right", "bottom"],
    900,
  );
  assert.ok(pts.every((p) => side(p) !== "left"));
  assert.ok(
    pts.every((p) => p.x >= 900),
    "every start is right of x 900",
  );
});
