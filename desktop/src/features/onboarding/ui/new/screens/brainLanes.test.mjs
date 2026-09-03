import assert from "node:assert/strict";
import test from "node:test";

import {
  bestSubscriptionId,
  defaultBrainId,
  defaultReason,
  isOpenRouterKey,
  laneForBrain,
  subscriptionTiles,
} from "./brainLanes.ts";

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

const notSignedIn = (id) => ({
  id,
  state: { state: "installed_not_signed_in" },
});
const absent = (id) => ({ id, state: { state: "not_installed" } });

const scan = (harnesses, recommended_id = null) => ({
  harnesses,
  recommended_id,
});

test("a tool that is not on this computer is not something you pay for", () => {
  const tiles = subscriptionTiles(
    scan([
      signedIn("claude", "Max", "Max 20x", 88, 72),
      notSignedIn("codex"),
      absent("goose"),
    ]),
    [],
  );
  assert.deepEqual(
    tiles.map((tile) => tile.id),
    ["claude", "codex"],
  );
});

test("the pill is the tightest window, the fact of a sign-in, or the sign-in itself", () => {
  const tiles = subscriptionTiles(
    scan([
      // 72 is the weekly window: whichever runs out first is what stops them.
      signedIn("claude", "Max", "Max 20x", 88, 72),
      signedIn("codex", "Unknown", null, null, null),
      notSignedIn("opencode"),
    ]),
    [],
  );
  assert.deepEqual(
    tiles.map((tile) => [tile.pill, tile.status]),
    [
      ["72% left", "ready"],
      ["Signed in", "ready"],
      ["Sign in", "needs-login"],
    ],
  );
});

test("a sign-in finished on this screen changes the tile without a second scan", () => {
  const tiles = subscriptionTiles(scan([notSignedIn("claude")]), [
    { id: "claude", label: "Claude Code", status: "ready" },
  ]);
  assert.deepEqual(tiles[0].status, "ready");
  assert.deepEqual(tiles[0].pill, "Signed in");
});

test("no scan falls back to the catalog rather than claiming nothing is installed", () => {
  const tiles = subscriptionTiles(null, [
    { id: "buzz-agent", label: "Colony Agent", status: "ready" },
    { id: "claude", label: "Claude Code", status: "ready" },
    { id: "codex", label: "Codex", status: "needs-login" },
    { id: "goose", label: "goose", status: "not-installed" },
  ]);
  assert.deepEqual(
    tiles.map((tile) => [tile.id, tile.pill]),
    [
      ["claude", "Signed in"],
      ["codex", "Sign in"],
    ],
  );
});

test("the default is the subscription with the most left", () => {
  const s = scan([
    signedIn("claude", "Max", "Max 20x", 88, 30),
    signedIn("codex", "Pro", "Pro", 80, 80),
  ]);
  assert.equal(bestSubscriptionId(s), "codex");
  assert.equal(defaultBrainId(s), "codex");
  assert.equal(defaultReason(s), "Codex Pro has 80% left, so we picked it.");
});

test("inside the equivalence band the better plan wins, and equal tiers keep scan order", () => {
  assert.equal(
    bestSubscriptionId(
      scan([
        signedIn("codex", "Pro", "Pro", 90, 89),
        signedIn("claude", "Max", "Max 20x", 85, 85),
      ]),
    ),
    "claude",
    "4 points apart, so the stronger plan decides",
  );
  assert.equal(
    bestSubscriptionId(
      scan([
        signedIn("claude", "Max", "Max", 80, 80),
        signedIn("codex", "Max", "Pro 20x", 80, 80),
      ]),
    ),
    "claude",
    "a tie must not reshuffle the scan's order",
  );
});

test("a plan with no measurements never wins the default", () => {
  // Treating silence as a full quota would spend a limit nobody could see.
  const s = scan([signedIn("codex", "Max", null, null, null)]);
  assert.equal(bestSubscriptionId(s), null);
  assert.equal(defaultBrainId(s), "buzz-agent");
  assert.match(
    defaultReason(s),
    /^Your tools reported no limits left to read,/,
  );
});

test("nothing detected falls back to Colony, never to OpenRouter", () => {
  for (const s of [null, scan([]), scan([notSignedIn("claude")])]) {
    assert.equal(defaultBrainId(s), "buzz-agent");
  }
  assert.equal(
    defaultReason(scan([])),
    "No subscription found, so Colony does the thinking and you pay per use.",
  );
});

test("each answer belongs to exactly one lane", () => {
  assert.equal(laneForBrain("claude"), "subscription");
  assert.equal(laneForBrain("buzz-agent"), "colony");
  assert.equal(laneForBrain("colony"), "colony");
  assert.equal(laneForBrain(null), "colony");
  assert.equal(laneForBrain("openrouter"), "openrouter");
});

test("only a key shaped like OpenRouter's opens the gate", () => {
  assert.equal(isOpenRouterKey("sk-or-v1-abcdef"), true);
  assert.equal(isOpenRouterKey("  sk-or-v1-abcdef  "), true);
  assert.equal(
    isOpenRouterKey("sk-or-"),
    false,
    "the prefix alone is not a key",
  );
  assert.equal(isOpenRouterKey("sk-ant-123"), false);
  assert.equal(isOpenRouterKey(""), false);
});
