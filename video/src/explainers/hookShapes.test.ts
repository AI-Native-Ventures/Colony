import assert from "node:assert/strict";
import { test } from "node:test";
import {
  drawHookShape,
  HOOK_SHAPE_IDS,
  HOOK_SHAPE_WIDTH,
} from "./hookShapes.ts";

/** Records what a shape draws, with the transform applied, so we can see where it lands. */
function recorder() {
  const fills: { x: number; y: number }[] = [];
  let ox = 0;
  let oy = 0;
  let k = 1;
  const stack: [number, number, number][] = [];
  const point = (x: number, y: number) => ({ x: ox + x * k, y: oy + y * k });
  let last = { x: 0, y: 0 };
  const ctx = {
    save: () => stack.push([ox, oy, k]),
    restore: () => {
      const s = stack.pop();
      if (s) [ox, oy, k] = s;
    },
    translate: (x: number, y: number) => {
      ox += x * k;
      oy += y * k;
    },
    scale: (s: number) => {
      k *= s;
    },
    beginPath: () => {},
    closePath: () => {},
    moveTo: (x: number, y: number) => {
      last = point(x, y);
    },
    lineTo: (x: number, y: number) => {
      last = point(x, y);
    },
    ellipse: (x: number, y: number) => {
      last = point(x, y);
    },
    arc: (x: number, y: number) => {
      last = point(x, y);
    },
    roundRect: (x: number, y: number) => {
      last = point(x, y);
    },
    rect: (x: number, y: number) => {
      last = point(x, y);
    },
    fill: (path?: { at: { x: number; y: number } }) => {
      fills.push(path ? point(path.at.x, path.at.y) : last);
    },
    stroke: () => {},
    set fillStyle(_: string) {},
    set globalCompositeOperation(_: string) {},
    set lineWidth(_: number) {},
    set lineCap(_: string) {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills };
}

class FakePath2D {
  at = { x: 12, y: 12 };
  d: string;
  constructor(d: string) {
    if (!d) throw new Error("empty path");
    this.d = d;
  }
}

test("every season hook shape draws itself around the spot it is given", () => {
  (globalThis as unknown as { Path2D: typeof FakePath2D }).Path2D = FakePath2D;
  assert.deepEqual([...HOOK_SHAPE_IDS].sort(), [
    "camera",
    "car",
    "chefHat",
    "croissant",
    "hardHat",
    "scissors",
    "sprayBottle",
    "wrench",
  ]);
  for (const id of HOOK_SHAPE_IDS) {
    const { ctx, fills } = recorder();
    const w = HOOK_SHAPE_WIDTH[id];
    drawHookShape(id, ctx, 1350, 560, w);
    assert.ok(fills.length > 0, `${id} drew nothing`);
    for (const f of fills) {
      assert.ok(Math.abs(f.x - 1350) <= w, `${id} fill at x ${f.x}`);
      assert.ok(Math.abs(f.y - 560) <= w, `${id} fill at y ${f.y}`);
    }
  }
});
