import assert from "node:assert/strict";
import test from "node:test";

import { accountReady } from "./AccountScreen.tsx";

const valid = {
  name: "Aisha Bello",
  email: "aisha@rosebankauto.co.za",
  password: "colonyprototype",
  city: "Johannesburg",
};

test("account_gate_requires_a_real_email", () => {
  assert.equal(accountReady(valid), true);
  assert.equal(accountReady({ ...valid, email: "not-an-email" }), false);
});

test("account_gate_requires_a_long_enough_password", () => {
  assert.equal(accountReady({ ...valid, password: "short" }), false);
});

test("account_gate_does_not_require_a_city", () => {
  // City is prefilled from IP and is optional. Nothing blocks on it.
  assert.equal(accountReady({ ...valid, city: "" }), true);
});
