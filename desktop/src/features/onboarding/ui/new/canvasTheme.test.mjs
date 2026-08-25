import assert from "node:assert/strict";
import test from "node:test";

import { canvasFor, HUE_SCATTER_TONES } from "./canvasTheme.ts";
import { ONBOARDING_STEPS } from "../../flow/steps.ts";

test("canvas_covers_every_step", () => {
  for (const step of ONBOARDING_STEPS) {
    const theme = canvasFor(step, "colony");
    assert.ok(theme.base, `no canvas tint for ${step}`);
    assert.ok(theme.hue, `no hue for ${step}`);
  }
});

test("canvas_is_one_solid_hue_never_a_gradient", () => {
  // A screen wears one colour. Earlier passes stacked three or four hues into
  // a mesh and it read as a rainbow wash.
  for (const step of ONBOARDING_STEPS) {
    const { base } = canvasFor(step, "colony");
    assert.match(
      base,
      /^#[0-9A-Fa-f]{6}$/,
      `${step} base is not a flat colour`,
    );
  }
});

test("canvas_ink_never_changes", () => {
  // Only the canvas moves. Type treatment stays constant across the flow.
  for (const step of ONBOARDING_STEPS) {
    assert.equal(canvasFor(step, "colony").ink, "dark");
  }
});

test("canvas_neighbouring_screens_never_repeat_a_hue", () => {
  // Colour marks where you are, so two screens in a row must not look alike.
  const hues = ONBOARDING_STEPS.map((step) => canvasFor(step, "colony").hue);
  for (let i = 1; i < hues.length; i += 1) {
    assert.notEqual(
      hues[i],
      hues[i - 1],
      `${ONBOARDING_STEPS[i]} repeats the hue before it`,
    );
  }
});

test("canvas_uses_more_than_one_hue_across_the_flow", () => {
  const hues = new Set(
    ONBOARDING_STEPS.map((step) => canvasFor(step, "colony").hue),
  );
  assert.ok(hues.size >= 4, `only ${hues.size} hues across the whole flow`);
});

test("canvas_brain_differs_by_track", () => {
  assert.notEqual(
    canvasFor("brain", "byo").hue,
    canvasFor("brain", "colony").hue,
  );
});

test("scatter_tones_exist_for_every_hue", () => {
  for (const step of ONBOARDING_STEPS) {
    const { hue } = canvasFor(step, "colony");
    assert.equal(HUE_SCATTER_TONES[hue].length, 4, `${hue} needs four tones`);
  }
});
