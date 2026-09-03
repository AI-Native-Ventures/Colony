import assert from "node:assert/strict";
import test from "node:test";

import { accountReady } from "./AccountScreen.tsx";

const valid = {
  name: "Aisha Bello",
  email: "aisha@rosebankauto.co.za",
  password: "colonyprototype",
};

test("account_gate_requires_a_real_email", () => {
  assert.equal(accountReady(valid), true);
  assert.equal(accountReady({ ...valid, email: "not-an-email" }), false);
});

test("account_gate_requires_a_long_enough_password", () => {
  assert.equal(accountReady({ ...valid, password: "short" }), false);
});

test("account_gate_requires_a_name", () => {
  assert.equal(accountReady({ ...valid, name: "   " }), false);
});

test("account_gate_asks_for_nothing_beyond_the_three_fields", () => {
  // The screen collects a name, an email and a password. City, country and
  // the photo left it: they are profile details, and the gate never depended
  // on them even when the screen still asked.
  assert.equal(accountReady({ ...valid, city: "", country: "" }), true);
  assert.equal(accountReady({ ...valid, avatarUrl: "" }), true);
});
