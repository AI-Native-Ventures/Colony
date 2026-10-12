import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AREA,
  layoutFor,
  lookAt,
  lookAtTime,
  type ProofStep,
  proofGroups,
} from "./canCantLayout.ts";

const SCREEN = { w: 1440, h: 900 };
const inside = (inner: number, outer: number) => inner <= outer + 1e-9;

test("a region fills as much of the area as fits, centred, with a little of the screen around it", () => {
  const region = { x: 380, y: 150, w: 638, h: 394 };
  const { card, view, scale } = layoutFor(region, SCREEN);
  assert.ok(view.x < region.x && view.y < region.y, JSON.stringify(view));
  assert.ok(view.x + view.w > region.x + region.w);
  assert.ok(view.y + view.h > region.y + region.h);
  assert.ok(Math.abs(view.w * scale - card.w) < 1e-6);
  assert.ok(Math.abs(view.h * scale - card.h) < 1e-6);
  assert.ok(
    Math.abs(card.w - AREA.w) < 1e-6 || Math.abs(card.h - AREA.h) < 1e-6,
    JSON.stringify(card),
  );
  assert.ok(Math.abs(card.x + card.w / 2 - (AREA.x + AREA.w / 2)) < 1e-6);
  assert.ok(Math.abs(card.y + card.h / 2 - (AREA.y + AREA.h / 2)) < 1e-6);
});

test("a small region is magnified, but no more than the cap", () => {
  const { card, scale } = layoutFor({ x: 600, y: 400, w: 80, h: 30 }, SCREEN);
  assert.equal(scale, 2.2);
  assert.ok(card.w < AREA.w && card.h < AREA.h);
});

test("the view never runs past the screen's edges", () => {
  const { view } = layoutFor({ x: 0, y: 870, w: 300, h: 30 }, SCREEN);
  assert.ok(view.x >= 0 && view.y >= 0, JSON.stringify(view));
  assert.ok(
    inside(view.x + view.w, SCREEN.w) && inside(view.y + view.h, SCREEN.h),
  );
});

test("with nothing to point at, the card shows the whole view", () => {
  const layout = layoutFor({ x: 363, y: 86, w: 700, h: 560 }, SCREEN);
  const look = lookAt(layout, null);
  assert.equal(look.zoom, 1);
  assert.equal(look.x, layout.view.x + layout.view.w / 2);
  assert.equal(look.y, layout.view.y + layout.view.h / 2);
});

test("pointing at a small part moves closer, and never shows past the view", () => {
  const layout = layoutFor({ x: 363, y: 86, w: 700, h: 560 }, SCREEN);
  const focus = { x: 380, y: 590, w: 89, h: 40 };
  const look = lookAt(layout, focus);
  assert.ok(look.zoom > 1.2, `${look.zoom}`);
  const halfW = layout.view.w / 2 / look.zoom;
  const halfH = layout.view.h / 2 / look.zoom;
  assert.ok(look.x - halfW >= layout.view.x - 1e-9);
  assert.ok(inside(look.x + halfW, layout.view.x + layout.view.w));
  assert.ok(inside(look.y + halfH, layout.view.y + layout.view.h));
  assert.ok(
    focus.x >= look.x - halfW && inside(focus.x + focus.w, look.x + halfW),
  );
  assert.ok(
    focus.y >= look.y - halfH && inside(focus.y + focus.h, look.y + halfH),
  );
});

test("pointing at a part as wide as the view does not move closer", () => {
  const layout = layoutFor({ x: 363, y: 86, w: 700, h: 560 }, SCREEN);
  assert.equal(lookAt(layout, { x: 370, y: 300, w: 690, h: 30 }).zoom, 1);
});

test("pointing at words wider than a quarter of the view keeps the whole view, so their row is not cut", () => {
  const layout = layoutFor({ x: 363, y: 423, w: 684, h: 525 }, SCREEN);
  const look = lookAt(layout, { x: 560, y: 593, w: 269, h: 17 });
  assert.deepEqual(look, lookAt(layout, null));
});

test("the look eases from one key to the next, and holds after", () => {
  const a = { x: 100, y: 100, zoom: 1 };
  const b = { x: 300, y: 200, zoom: 2 };
  const keys = [
    { at: 0, look: a },
    { at: 2, look: b },
  ];
  assert.deepEqual(lookAtTime(1, keys), a);
  assert.deepEqual(lookAtTime(5, keys), b);
  const mid = lookAtTime(2.4, keys);
  assert.ok(mid.x > a.x && mid.x < b.x && mid.zoom > 1 && mid.zoom < 2);
});

const step = (id: string, from: number, to: number, y = 86): ProofStep => ({
  id,
  shot: "outreach-card",
  from,
  to,
  region: { x: 363, y, w: 700, h: 560 },
  focus: null,
  screen: { w: 1080, h: 900 },
});

test("claims in a row that show the same part of the screen share one card", () => {
  const groups = proofGroups([step("a", 2, 7), step("b", 7, 12)]);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].steps.map((s) => s.id),
    ["a", "b"],
  );
  assert.equal(groups[0].from, 2);
  assert.equal(groups[0].to, 12);
});

test("a claim that shows another part of the screen starts a new card", () => {
  const groups = proofGroups([step("a", 2, 7), step("b", 7, 12, 123)]);
  assert.deepEqual(
    groups.map((g) => g.steps.map((s) => s.id)),
    [["a"], ["b"]],
  );
});
