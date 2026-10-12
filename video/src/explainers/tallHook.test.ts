import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mulberry32 } from "../launch/math.ts";
import {
  type Box,
  CAPTION_BOX,
  clearOfCovers,
  insideFeed,
  TALL_H,
  TALL_W,
} from "../launch/tall/frame.ts";
import {
  HOOK_SHAPE_IDS,
  HOOK_SHAPE_WIDTH,
  type HookShapeId,
  hookShapeHeight,
} from "./hookShapes.ts";
import { edgeStarts } from "./swarmShape.ts";
import { hookWordSize, hookWordsBox, TALL_HOOK } from "./tallHook.ts";

/** Each explainer's hook, read from its source so the test sees the real words. */
const HOOKS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
  const src = readFileSync(
    new URL(`./Explainer0${n}.tsx`, import.meta.url),
    "utf8",
  );
  const lines = src.match(/lines: \["([^"]+)", "([^"]+)"\]/);
  const shape = src.match(/shape: "([A-Za-z]+)"/);
  assert.ok(lines && shape, `episode ${n} hook not found`);
  return {
    n,
    lines: [lines[1], lines[2]] as [string, string],
    shape: shape[1] as HookShapeId,
  };
});

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

function toolBox(shape: HookShapeId): Box {
  const w = HOOK_SHAPE_WIDTH[shape];
  const h = hookShapeHeight(shape, w);
  return {
    x: TALL_HOOK.shape.cx - w / 2,
    y: TALL_HOOK.shape.cy - h / 2,
    w,
    h,
  };
}

test("every hook line fits the frame on one line, big enough to read", () => {
  for (const hook of HOOKS) {
    const size = hookWordSize(hook.lines, TALL_HOOK);
    assert.ok(size <= TALL_HOOK.words.size, `episode ${hook.n}`);
    assert.ok(size >= 84, `episode ${hook.n} shrinks to ${size}`);
    const longest = Math.max(...hook.lines.map((l) => l.length));
    assert.ok(longest * 0.56 * size <= TALL_HOOK.words.width, `${hook.n}`);
  }
});

test("the words, the tool and the captions never overlap, and all sit in view", () => {
  for (const hook of HOOKS) {
    const words = hookWordsBox(hook.lines, TALL_HOOK);
    const tool = toolBox(hook.shape);
    for (const [name, box] of Object.entries({ words, tool })) {
      assert.ok(clearOfCovers(box), `episode ${hook.n} ${name} is covered`);
      assert.ok(insideFeed(box), `episode ${hook.n} ${name} leaves the feed`);
      assert.ok(!overlaps(box, CAPTION_BOX), `${hook.n} ${name} hits captions`);
    }
    assert.ok(!overlaps(words, tool), `episode ${hook.n} tool hits the words`);
  }
});

test("every tool shape has a known height", () => {
  for (const id of HOOK_SHAPE_IDS) {
    const h = hookShapeHeight(id, 100);
    assert.ok(h > 0 && h <= 130, id);
  }
});

test("the hook's ants fly in from off the frame, below the words", () => {
  const starts = edgeStarts(
    700,
    mulberry32(1),
    { w: TALL_W, h: TALL_H },
    TALL_HOOK.sides,
    TALL_HOOK.minX,
    TALL_HOOK.minY,
  );
  const wordsBottom = hookWordsBox(["Ab", "Cd"], TALL_HOOK);
  for (const p of starts) {
    const outside = p.x < 0 || p.x > TALL_W || p.y < 0 || p.y > TALL_H;
    assert.ok(outside, `${p.x},${p.y} starts on screen`);
    assert.ok(p.y > wordsBottom.y + wordsBottom.h, `${p.x},${p.y} by words`);
  }
});
