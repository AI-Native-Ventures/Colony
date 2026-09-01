import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldOfferUpgrade,
  turnsPerDay,
} from "../../../shared/api/tauriOpenRouterQuota.ts";

/**
 * The card's visibility and its numbers both derive from the quota, so these
 * pin the decisions rather than the markup: when it renders, what shortfall it
 * quotes, and which claims it is allowed to make.
 */

const quota = (credits, usage = 0) => {
  const met = credits >= 10;
  return {
    total_credits_usd: credits,
    total_usage_usd: usage,
    threshold_met: met,
    requests_per_day: met ? 1000 : 50,
    requests_per_minute: 20,
    usd_to_threshold: met ? null : 10 - credits,
  };
};

test("renders only below the threshold", () => {
  assert.equal(shouldOfferUpgrade(quota(0)), true);
  assert.equal(shouldOfferUpgrade(quota(9.99)), true);
  assert.equal(shouldOfferUpgrade(quota(10)), false);
});

test("a spent-down paying account is never pitched again", () => {
  // Bought $250, used $174.93 — the live shape. Lifetime purchase decides.
  assert.equal(shouldOfferUpgrade(quota(250, 174.93)), false);
  // And the boundary case that would break if balance were compared instead.
  assert.equal(
    shouldOfferUpgrade(quota(10, 10)),
    false,
    "credit fully spent must not re-trigger the offer",
  );
});

test("an unknown quota renders nothing", () => {
  assert.equal(
    shouldOfferUpgrade(null),
    false,
    "a failed check must not be treated as below-threshold",
  );
});

test("a partial balance quotes the remainder, not the full $10", () => {
  const q = quota(4);
  assert.equal(q.usd_to_threshold, 6);
  assert.equal(
    `Add $${q.usd_to_threshold.toFixed(2)} on OpenRouter`,
    "Add $6.00 on OpenRouter",
  );
});

test("the before/after turn counts come from the measured floor", () => {
  assert.deepEqual(turnsPerDay(50), { low: 2, high: 10 });
  assert.deepEqual(turnsPerDay(1000), { low: 50, high: 200 });
});

test("the per-minute cap travels with the quota at both tiers", () => {
  assert.equal(quota(0).requests_per_minute, 20);
  assert.equal(quota(250).requests_per_minute, 20);
});
