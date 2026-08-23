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

test("canvas_is_dark_on_every_step", () => {
  // Onboarding is a threshold, not the app. Every screen carries light ink on
  // a dark field so the colony glows, and so arriving in the light workspace
  // reads as arriving somewhere.
  for (const step of ONBOARDING_STEPS) {
    assert.equal(
      canvasFor(step, "colony").ink,
      "light",
      `${step} must use light ink on the dark field`,
    );
  }
});

test("canvas_bases_stay_close_together", () => {
  // The field should drift between screens, never jump. A base that wanders
  // far makes a screen read as a different product.
  const channels = ONBOARDING_STEPS.map((step) => {
    const hex = canvasFor(step, "colony").base.slice(1);
    return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  });
  for (const index of [0, 1, 2]) {
    const values = channels.map((rgb) => rgb[index]);
    const spread = Math.max(...values) - Math.min(...values);
    assert.ok(spread <= 16, `channel ${index} spread ${spread} is too wide`);
  }
});

test("canvas_brain_differs_by_track", () => {
  const byo = canvasFor("brain", "byo");
  const colony = canvasFor("brain", "colony");
  assert.notEqual(byo.base, colony.base);
});
