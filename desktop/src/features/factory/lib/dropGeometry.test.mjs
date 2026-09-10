import assert from "node:assert/strict";
import test from "node:test";

const importPath = `./dropGeometry.ts?test=${Math.random()}`;

async function load() {
  return await import(importPath);
}

const RECT = { left: 0, top: 0, width: 200, height: 200 };

test("resolveDropEdge: centre of the pane is a centre drop", async () => {
  const m = await load();
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 100, y: 100 }), "center");
});

test("resolveDropEdge: each edge band resolves to its edge", async () => {
  const m = await load();
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 20, y: 100 }), "left");
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 180, y: 100 }), "right");
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 100, y: 20 }), "top");
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 100, y: 180 }), "bottom");
});

test("resolveDropEdge: the band boundary itself is centre", async () => {
  const m = await load();
  // 30% of 200 is 60: exactly on the boundary is outside the band.
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 60, y: 100 }), "center");
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 140, y: 100 }), "center");
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 100, y: 60 }), "center");
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 100, y: 140 }), "center");
  // One pixel inside is in the band.
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 59, y: 100 }), "left");
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 141, y: 100 }), "right");
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 100, y: 59 }), "top");
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 100, y: 141 }), "bottom");
});

test("resolveDropEdge: corners resolve to the horizontal edge", async () => {
  const m = await load();
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 30, y: 30 }), "left");
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 170, y: 170 }), "right");
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 170, y: 30 }), "right");
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 30, y: 170 }), "left");
});

test("resolveDropEdge: the nearer edge wins inside two bands", async () => {
  const m = await load();
  // Deep in the top band, shallow in the left band.
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 50, y: 5 }), "top");
  // Deep in the left band, shallow in the bottom band.
  assert.strictEqual(m.resolveDropEdge(RECT, { x: 5, y: 150 }), "left");
});

test("resolveDropEdge: bands scale per axis, not by the smaller side", async () => {
  const m = await load();
  const wide = { left: 0, top: 0, width: 1000, height: 100 };
  // 200px in is inside the left 30% of a 1000px-wide pane.
  assert.strictEqual(m.resolveDropEdge(wide, { x: 200, y: 50 }), "left");
  // 400px in is not.
  assert.strictEqual(m.resolveDropEdge(wide, { x: 400, y: 50 }), "center");
});

test("resolveDropEdge: an offset rect is measured from its own origin", async () => {
  const m = await load();
  const offset = { left: 500, top: 300, width: 200, height: 200 };
  assert.strictEqual(m.resolveDropEdge(offset, { x: 520, y: 400 }), "left");
  assert.strictEqual(m.resolveDropEdge(offset, { x: 600, y: 400 }), "center");
  assert.strictEqual(m.resolveDropEdge(offset, { x: 600, y: 480 }), "bottom");
});

test("resolveDropEdge: a degenerate rect is a centre drop", async () => {
  const m = await load();
  assert.strictEqual(
    m.resolveDropEdge({ left: 0, top: 0, width: 0, height: 0 }, { x: 0, y: 0 }),
    "center",
  );
});
