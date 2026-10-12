import assert from "node:assert/strict";
import { test } from "node:test";
import { PANEL_ORDER, PANS } from "../wide/film90.ts";
import { TALL_H } from "./frame.ts";
import { panelY, scrollY } from "./scroll.ts";

test("each scene is one tall frame below the last", () => {
  PANEL_ORDER.forEach((id, i) => assert.equal(panelY(id), i * TALL_H));
});

test("the camera stays on the first scene until the first scroll", () => {
  assert.equal(scrollY(0), 0);
  assert.equal(scrollY(PANS[0].start), 0);
});

test("each scroll lands exactly on its scene and holds there until the next", () => {
  PANS.forEach((pan, i) => {
    const next = PANS[i + 1]?.start ?? pan.end + 5;
    for (const t of [pan.end, (pan.end + next) / 2, next]) {
      assert.equal(scrollY(t), panelY(pan.to), `${pan.to} at ${t}`);
    }
  });
});

test("the camera only moves during a scroll, and only downwards", () => {
  const inScroll = (t: number) => PANS.some((p) => t >= p.start && t <= p.end);
  let last = scrollY(0);
  for (let f = 1; f < 119 * 30; f++) {
    const t = f / 30;
    const before = (f - 1) / 30;
    const y = scrollY(t);
    if (!inScroll(t) && !inScroll(before)) {
      assert.equal(y, last, `moved at ${t}`);
    }
    assert.ok(y >= last - 1e-9, `went up at ${t}`);
    last = y;
  }
});
