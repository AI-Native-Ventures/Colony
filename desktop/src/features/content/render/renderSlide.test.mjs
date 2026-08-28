// The box the font gate diffs, tested without a browser.
//
// The rest of renderSlide is DOM and canvas work, proven in WebKit by
// tests/e2e/content-render.spec.ts rather than here. What is pure, and what
// silently produces a wrong answer if it drifts, is which pixels the font
// gate compares: too small a box and a real face change averages out, too
// large and an identical ground drowns it.

import assert from "node:assert/strict";
import test from "node:test";

import { textBox } from "./renderSlide.ts";

const run = (x, y, width, height) => ({
  alpha: 1,
  box: { height, width, x, y },
  color: "rgb(255, 255, 255)",
  label: "head",
});

test("the box is the union of every run, not just the first", () => {
  const box = textBox(
    [run(100, 200, 300, 80), run(120, 320, 260, 40)],
    1080,
    1350,
  );
  assert.deepEqual(box, { height: 160, width: 300, x: 100, y: 200 });
});

test("a run hanging off the canvas is clipped to it", () => {
  const box = textBox([run(-40, -20, 200, 100)], 1080, 1350);
  assert.deepEqual(box, { height: 80, width: 160, x: 0, y: 0 });
});

test("a card with no runs is refused rather than measured against nothing", () => {
  assert.throws(() => textBox([], 1080, 1350), /no \[data-contrast\] runs/);
});

test("runs entirely off the canvas are refused, not silently emptied", () => {
  assert.throws(
    () => textBox([run(2000, 2000, 100, 100)], 1080, 1350),
    /laid out off the canvas/,
  );
});
