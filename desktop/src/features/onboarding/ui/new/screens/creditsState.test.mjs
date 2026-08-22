import assert from "node:assert/strict";
import test from "node:test";

import { AMOUNTS_USD, MIN_USD, amountValid } from "./CreditsScreen.tsx";

test("credits_minimum_is_five_dollars", () => {
  assert.equal(MIN_USD, 5);
  assert.equal(amountValid(5), true);
  assert.equal(amountValid(4), false);
  assert.equal(amountValid(Number.NaN), false);
});

test("credits_presets_all_clear_the_minimum", () => {
  for (const amount of AMOUNTS_USD) {
    assert.equal(amountValid(amount), true);
  }
});
