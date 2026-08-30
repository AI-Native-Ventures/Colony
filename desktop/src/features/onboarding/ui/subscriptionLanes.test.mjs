import assert from "node:assert/strict";
import test from "node:test";

import {
  harnessLabel,
  isUsable,
  remainingPercent,
} from "../../../shared/api/tauriSubscriptions.ts";

const signedIn = (id, tier, planLabel, short, long) => ({
  id,
  state: {
    state: "signed_in",
    tier,
    plan_label: planLabel,
    short_window:
      short === null ? null : { remaining_percent: short, resets_at: null },
    long_window:
      long === null ? null : { remaining_percent: long, resets_at: null },
    usage_captured_at: null,
  },
});

test("remaining is the scarcer window, because that is what stops the user first", () => {
  assert.equal(
    remainingPercent(signedIn("claude", "Max", "Max 20x", 88, 57)),
    57,
  );
});

test("a harness reporting no usage is usable but has no percentage", () => {
  const h = signedIn("codex", "Max", "Pro 20x", null, null);
  assert.equal(isUsable(h), true, "still offered to the user");
  assert.equal(
    remainingPercent(h),
    null,
    "null, never 0 — silence must not render as an exhausted quota",
  );
});

test("a single reported window is used on its own", () => {
  assert.equal(
    remainingPercent(signedIn("claude", "Max", "Max", 42, null)),
    42,
  );
  assert.equal(
    remainingPercent(signedIn("claude", "Max", "Max", null, 42)),
    42,
  );
});

test("not-signed-in and not-installed are never usable and never ranked", () => {
  for (const state of ["not_installed", "installed_not_signed_in"]) {
    const h = { id: "codex", state: { state } };
    assert.equal(isUsable(h), false);
    assert.equal(remainingPercent(h), null);
  }
});

test("labels carry the plan when known and degrade to the harness name when not", () => {
  assert.equal(
    harnessLabel(signedIn("claude", "Max", "Max 20x", 90, 90)),
    "Claude Max 20x",
  );
  assert.equal(
    harnessLabel(signedIn("claude", "Unknown", null, 90, 90)),
    "Claude",
    "an unrecognised plan still shows the harness rather than disappearing",
  );
  assert.equal(
    harnessLabel({ id: "goose", state: { state: "not_installed" } }),
    "goose",
  );
});
