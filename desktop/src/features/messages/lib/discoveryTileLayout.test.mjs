import assert from "node:assert/strict";
import test from "node:test";

import { discoveryTileLayout } from "./discoveryTileLayout.ts";

test("one entity renders as a single wide tile", () => {
  assert.deepEqual(discoveryTileLayout(1), {
    variant: "wide",
    visibleCount: 1,
    hiddenCount: 0,
  });
});

test("two through four entities render as a grid with nothing hidden", () => {
  for (const count of [2, 3, 4]) {
    assert.deepEqual(discoveryTileLayout(count), {
      variant: "grid",
      visibleCount: count,
      hiddenCount: 0,
    });
  }
});

test("more than four renders the first four plus the rest as overflow", () => {
  assert.deepEqual(discoveryTileLayout(6), {
    variant: "grid",
    visibleCount: 4,
    hiddenCount: 2,
  });
  assert.deepEqual(discoveryTileLayout(30), {
    variant: "grid",
    visibleCount: 4,
    hiddenCount: 26,
  });
});

test("no entities renders nothing", () => {
  assert.deepEqual(discoveryTileLayout(0), {
    variant: "wide",
    visibleCount: 0,
    hiddenCount: 0,
  });
});
