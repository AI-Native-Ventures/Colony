import assert from "node:assert/strict";
import test from "node:test";

import {
  canvasFor,
  contrastRatio,
  disabledActionColours,
  COLONY_INK,
  HUE_CANVAS,
  HUE_SCATTER_TONES,
} from "./canvasTheme.ts";
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

test("disabled_action_has_a_colour_on_every_screen", () => {
  for (const step of ONBOARDING_STEPS) {
    const { disabledBg, disabledInk } = canvasFor(step, "colony");
    assert.match(
      disabledBg,
      /^#[0-9a-f]{6}$/,
      `${step} has no disabled fill of its own`,
    );
    assert.match(disabledInk, /^#[0-9a-fA-F]{6}$/, `${step} disabled label`);
  }
});

test("disabled_label_clears_three_to_one_on_its_own_fill", () => {
  // The rule the fixed lilac broke: a disabled action still has to be read.
  for (const step of ONBOARDING_STEPS) {
    const { disabledBg, disabledInk } = canvasFor(step, "colony");
    const ratio = contrastRatio(disabledInk, disabledBg);
    assert.ok(
      ratio >= 3,
      `${step} disabled label is ${ratio.toFixed(2)}:1 on its fill`,
    );
  }
});

test("disabled_fill_is_this_screen_s_hue_not_one_fixed_colour", () => {
  // The whole point: five canvases, five fills. A single value here is the bug
  // this replaced, whatever that value happens to be.
  const fills = new Set(
    Object.values(HUE_CANVAS).map(
      (base) => disabledActionColours(base).disabledBg,
    ),
  );
  assert.equal(
    fills.size,
    Object.keys(HUE_CANVAS).length,
    "two hues share a disabled fill",
  );
  const perStep = new Set(
    ONBOARDING_STEPS.map((step) => canvasFor(step, "colony").disabledBg),
  );
  assert.ok(
    perStep.size >= 4,
    `only ${perStep.size} disabled fills across the whole flow`,
  );
});

test("disabled_fill_separates_from_the_canvas_behind_it", () => {
  // Invisible-on-pink was half the original complaint: the fill has to be a
  // shade of the canvas, not the canvas.
  for (const step of ONBOARDING_STEPS) {
    const { base, disabledBg } = canvasFor(step, "colony");
    const ratio = contrastRatio(disabledBg, base);
    assert.ok(
      ratio >= 1.4,
      `${step} disabled fill is ${ratio.toFixed(2)}:1 against its canvas`,
    );
  }
});

test("contrast_ratio_matches_known_wcag_values", () => {
  assert.equal(Math.round(contrastRatio("#ffffff", "#000000")), 21);
  assert.equal(Math.round(contrastRatio(COLONY_INK, COLONY_INK)), 1);
});

test("scatter_tones_exist_for_every_hue", () => {
  for (const step of ONBOARDING_STEPS) {
    const { hue } = canvasFor(step, "colony");
    assert.equal(HUE_SCATTER_TONES[hue].length, 4, `${hue} needs four tones`);
  }
});
