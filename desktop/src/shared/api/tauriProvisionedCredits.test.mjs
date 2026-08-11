import assert from "node:assert/strict";
import test from "node:test";

import {
  formatNanousdAsUsd,
  getColonyCreditsStatus,
} from "./tauriProvisionedCredits.ts";

test("formats nanodollars with integer arithmetic", () => {
  assert.equal(formatNanousdAsUsd("123456789"), "$0.12");
  assert.equal(formatNanousdAsUsd("1000000000"), "$1.00");
});

test("negative and zero balances are depleted and display zero", () => {
  assert.equal(formatNanousdAsUsd("-1"), "$0.00");
  assert.equal(formatNanousdAsUsd("0"), "$0.00");
  assert.equal(getColonyCreditsStatus("-1"), "depleted");
  assert.equal(getColonyCreditsStatus("0"), "depleted");
  assert.equal(getColonyCreditsStatus("1"), "active");
});
