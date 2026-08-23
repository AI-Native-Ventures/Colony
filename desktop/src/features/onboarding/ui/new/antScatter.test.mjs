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

test("scatter_stays_faint", () => {
  // The colony sits behind the work. An ant at full opacity competes with the
  // text someone is trying to read.
  for (const ant of layOutScatter(40)) {
    assert.ok(ant.opacity <= 0.26, `opacity ${ant.opacity} is too strong`);
    assert.ok(ant.opacity >= 0.1, `opacity ${ant.opacity} is invisible`);
  }
});

test("scatter_cycles_every_brand_hue", () => {
  const hues = new Set(layOutScatter(15).map((ant) => ant.hue));
  assert.equal(hues.size, 5, "all five brand accent hues should appear");
});

test("scatter_is_deterministic_for_a_given_source", () => {
  const first = layOutScatter(6, sequence([0.1, 0.2, 0.3, 0.4, 0.5]));
  const second = layOutScatter(6, sequence([0.1, 0.2, 0.3, 0.4, 0.5]));
  assert.deepEqual(first, second);
});
