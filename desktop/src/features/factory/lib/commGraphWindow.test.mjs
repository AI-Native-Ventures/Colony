import assert from "node:assert/strict";
import test from "node:test";

const importPath = `./commGraphWindow.ts?test=${Math.random()}`;

async function load() {
  return import(importPath);
}

test("the chip offers 30 min, 2 h and today in that order", async () => {
  const m = await load();
  assert.deepStrictEqual(
    m.COMM_GRAPH_WINDOWS.map((option) => option.id),
    ["30m", "2h", "today"],
  );
});

test("fixed windows are exact spans", async () => {
  const m = await load();
  const now = Date.now();
  assert.strictEqual(m.commGraphWindowMs("30m", now), 1_800_000);
  assert.strictEqual(m.commGraphWindowMs("2h", now), 7_200_000);
});

test("today reaches back to local midnight", async () => {
  const m = await load();
  const now = new Date();
  now.setHours(9, 30, 15, 500);
  const expected = 9 * 60 * 60 * 1_000 + 30 * 60 * 1_000 + 15 * 1_000 + 500;
  assert.strictEqual(m.commGraphWindowMs("today", now.getTime()), expected);
});

test("today at midnight is a zero-length window, never negative", async () => {
  const m = await load();
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  assert.strictEqual(m.commGraphWindowMs("today", midnight.getTime()), 0);
});
