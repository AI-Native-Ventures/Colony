import assert from "node:assert/strict";
import test from "node:test";

import { layOutScatter } from "./AntScatter.tsx";

/** Deterministic stand-in for Math.random, cycling a fixed sequence. */
function sequence(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

test("scatter_gait_delays_are_spread", () => {
  // The property that makes the field read as life rather than wallpaper: no
  // two ants may share a gait phase. If this ever collapses to a single value
  // the whole colony steps in lockstep, which looks like a repeating texture.
  const ants = layOutScatter(26);
  const delays = new Set(ants.map((ant) => ant.gaitDelay));
  assert.ok(
    delays.size > 20,
    `only ${delays.size} distinct gait phases across 26 ants`,
  );
});

test("scatter_gait_delays_are_negative_and_within_one_cycle", () => {
  // Negative delays start each ant mid-stride, so the field is already moving
  // on the first painted frame. Anything beyond one 0.42s cycle is equivalent
  // to a smaller value and just obscures intent.
  for (const ant of layOutScatter(40)) {
    assert.ok(
      ant.gaitDelay <= 0,
      `gait delay ${ant.gaitDelay} is not negative`,
    );
    assert.ok(
      ant.gaitDelay > -0.42,
      `gait delay ${ant.gaitDelay} exceeds a cycle`,
    );
  }
});

test("scatter_is_visible_but_behind_the_work", () => {
  // Ants have to be seen. The first pass sat at 0.10 to 0.26 opacity and
  // roughly a centimetre across, which read as dust rather than as a colony.
  // The ceiling still keeps them behind the type someone is reading.
  for (const ant of layOutScatter(40)) {
    assert.ok(ant.opacity <= 0.48, `opacity ${ant.opacity} is too strong`);
    assert.ok(ant.opacity >= 0.22, `opacity ${ant.opacity} is invisible`);
  }
});

test("scatter_uses_all_four_tones_of_the_screen_hue", () => {
  // The landing page settled on four tones of one hue precisely so the field
  // reads as texture rather than as five competing confetti colours. An ant
  // picks a tone; the screen supplies the hue.
  const ants = layOutScatter(16);
  for (const ant of ants) {
    assert.equal(typeof ant.hue, "undefined", "an ant must not pick a hue");
    assert.ok(
      Number.isInteger(ant.tone) && ant.tone >= 0 && ant.tone < 4,
      `tone ${ant.tone} is outside the tonal palette`,
    );
  }
  assert.equal(new Set(ants.map((a) => a.tone)).size, 4, "all four tones");
});

test("scatter_is_deterministic_for_a_given_source", () => {
  const first = layOutScatter(6, sequence([0.1, 0.2, 0.3, 0.4, 0.5]));
  const second = layOutScatter(6, sequence([0.1, 0.2, 0.3, 0.4, 0.5]));
  assert.deepEqual(first, second);
});

test("scatter_ants_are_large_enough_to_read_as_ants", () => {
  // At under a rem the mark is an indistinct speck. These have to be legible
  // as the Colony ant or they are just noise on the field.
  for (const ant of layOutScatter(40)) {
    assert.ok(ant.size >= 1.5, `size ${ant.size}rem is too small to read`);
    assert.ok(ant.size <= 3, `size ${ant.size}rem competes with content`);
  }
});
