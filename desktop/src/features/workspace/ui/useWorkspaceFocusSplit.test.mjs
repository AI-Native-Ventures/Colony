import assert from "node:assert/strict";
import test from "node:test";

import {
  clampFocusThreadWidth,
  DEFAULT_FOCUS_THREAD_RATIO,
} from "./useWorkspaceFocusSplit.ts";

test("the default focus split is 20/80", () => {
  assert.equal(DEFAULT_FOCUS_THREAD_RATIO, 0.2);
  assert.equal(clampFocusThreadWidth(320, 1600), 320);
});

test("thread and workspace minimum widths are enforced", () => {
  assert.equal(clampFocusThreadWidth(100, 1200), 280);
  assert.equal(clampFocusThreadWidth(1100, 1200), 880);
});

test("narrow containers give the workspace priority after thread minimum", () => {
  assert.equal(clampFocusThreadWidth(300, 500), 180);
});
