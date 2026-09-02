import assert from "node:assert/strict";
import test from "node:test";

import { billingTab, validateSpendSearch } from "./spendSearch.ts";

test("the tab param is narrowed to the two Billing panes", () => {
  assert.deepEqual(validateSpendSearch({ tab: "credits" }), {
    tab: "credits",
  });
  assert.deepEqual(validateSpendSearch({ tab: "spend" }), { tab: "spend" });
});

test("anything that is not a pane name is dropped", () => {
  assert.deepEqual(validateSpendSearch({ tab: "ledger" }), { tab: undefined });
  assert.deepEqual(validateSpendSearch({ tab: 7 }), { tab: undefined });
  assert.deepEqual(validateSpendSearch({}), { tab: undefined });
});

test("Spend is the pane a bare /spend shows", () => {
  assert.equal(billingTab({}), "spend");
  assert.equal(billingTab({ tab: undefined }), "spend");
  assert.equal(billingTab({ tab: "credits" }), "credits");
});
