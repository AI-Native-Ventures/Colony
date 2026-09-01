import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldOfferUpgrade,
  turnsPerDay,
} from "../../../shared/api/tauriOpenRouterQuota.ts";

const quota = (credits, met) => ({
  total_credits_usd: credits,
  total_usage_usd: 0,
  threshold_met: met,
  requests_per_day: met ? 1000 : 50,
  requests_per_minute: 20,
  usd_to_threshold: met ? null : 10 - credits,
});

test("50 requests a day is 2 to 10 agent turns", () => {
  // 50/20 = 2.5, floored to 2. Copy elsewhere said "3 to 10", which rounded the
  // pessimistic end in our favour — the floor is the honest bound to quote.
  assert.deepEqual(turnsPerDay(50), { low: 2, high: 10 });
});

test("1,000 a day is 50 to 200 turns", () => {
  assert.deepEqual(turnsPerDay(1000), { low: 50, high: 200 });
});

test("the offer applies only below the threshold", () => {
  assert.equal(shouldOfferUpgrade(quota(0, false)), true);
  assert.equal(shouldOfferUpgrade(quota(4, false)), true);
  assert.equal(shouldOfferUpgrade(quota(10, true)), false);
  assert.equal(shouldOfferUpgrade(quota(250, true)), false);
});

test("an unknown quota never triggers the offer", () => {
  assert.equal(
    shouldOfferUpgrade(null),
    false,
    "could-not-check must not be treated as below-threshold — that shows the offer to someone who already paid",
  );
});
