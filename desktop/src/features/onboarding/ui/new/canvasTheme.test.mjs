import assert from "node:assert/strict";
import test from "node:test";

import { canvasFor } from "./canvasTheme.ts";
import { ONBOARDING_STEPS } from "../../flow/steps.ts";

test("canvas_covers_every_step", () => {
  for (const step of ONBOARDING_STEPS) {
    const theme = canvasFor(step, "colony");
    assert.ok(theme.base, `no base colour for ${step}`);
    assert.ok(theme.mesh.length >= 2, `thin mesh for ${step}`);
  }
});

test("canvas_credits_is_the_only_dark_screen", () => {
  const dark = ONBOARDING_STEPS.filter(
    (step) => canvasFor(step, "colony").ink === "light",
  );
  assert.deepEqual(dark, ["credits"]);
});

test("canvas_brain_differs_by_track", () => {
  const byo = canvasFor("brain", "byo");
  const colony = canvasFor("brain", "colony");
  assert.notEqual(byo.base, colony.base);
});
