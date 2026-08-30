import assert from "node:assert/strict";
import test from "node:test";

import {
  harnessLabel,
  isUsable,
  remainingPercent,
} from "../../../shared/api/tauriSubscriptions.ts";

/**
 * These cover the data contract the lane screen renders from. The component
 * itself is exercised by the smoke E2E; what matters here is that the three
 * detection states stay distinguishable, because collapsing them is the one
 * failure that silently invents a subscription or hides a real one.
 */

const signedIn = (id, planLabel, short, long, capturedAt = null) => ({
  id,
  state: {
    state: "signed_in",
    tier: planLabel?.includes("Max") ? "Max" : "Pro",
    plan_label: planLabel,
    short_window:
      short === null ? null : { remaining_percent: short, resets_at: null },
    long_window:
      long === null ? null : { remaining_percent: long, resets_at: null },
    usage_captured_at: capturedAt,
  },
});

test("only signed-in harnesses become lanes", () => {
  const scan = [
    signedIn("claude", "Max 20x", 88, 57),
    { id: "codex", state: { state: "installed_not_signed_in" } },
    { id: "goose", state: { state: "not_installed" } },
  ];
  const lanes = scan.filter(isUsable).map((h) => h.id);
  assert.deepEqual(lanes, ["claude"]);
});

test("every signed-in subscription is a lane, not just the recommended one", () => {
  const scan = [
    signedIn("claude", "Max 20x", 88, 57),
    signedIn("codex", "Pro 20x", 95, 92),
  ];
  assert.equal(
    scan.filter(isUsable).length,
    2,
    "someone paying for both must see both and choose",
  );
});

test("the badge percentage is the scarcer window", () => {
  assert.equal(remainingPercent(signedIn("claude", "Max 20x", 88, 57)), 57);
});

test("a harness with no usage still renders a lane but no percentage", () => {
  const h = signedIn("codex", "Pro 20x", null, null);
  assert.equal(isUsable(h), true);
  assert.equal(
    remainingPercent(h),
    null,
    "null must reach the component so it renders no meter, rather than 0% left",
  );
});

test("detection list covers every probed harness, including misses", () => {
  const scan = [
    signedIn("claude", "Max 20x", 88, 57),
    { id: "codex", state: { state: "installed_not_signed_in" } },
    { id: "opencode", state: { state: "not_installed" } },
    { id: "goose", state: { state: "not_installed" } },
  ];
  assert.equal(scan.length, 4, "the list explains why a lane is absent");
  assert.equal(harnessLabel(scan[0]), "Claude Max 20x");
  assert.equal(harnessLabel(scan[1]), "Codex");
});

test("staleness is decided from usage_captured_at, and absent means not stale", () => {
  const HOUR = 60 * 60 * 1000;
  const nowSecs = Math.floor(Date.now() / 1000);
  const fresh = signedIn("claude", "Max 20x", 88, 57, nowSecs);
  const old = signedIn("claude", "Max 20x", 88, 57, nowSecs - 5 * 3600);
  const unknown = signedIn("claude", "Max 20x", 88, 57, null);

  const isStale = (h) =>
    h.state.usage_captured_at !== null &&
    Date.now() - h.state.usage_captured_at * 1000 > HOUR;

  assert.equal(isStale(fresh), false);
  assert.equal(isStale(old), true);
  assert.equal(
    isStale(unknown),
    false,
    "an unknown capture time must not be reported as stale — that is a claim we cannot make",
  );
});
