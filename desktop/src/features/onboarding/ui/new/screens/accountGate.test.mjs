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

test("account_gate_defers_profile_details", () => {
  assert.equal(accountReady({ ...valid, name: "   " }), true);
});

test("account_gate_asks_only_email_and_password", () => {
  // The screen collects a name, an email and a password. City, country and
  // the photo left it: they are profile details, and the gate never depended
  // on them even when the screen still asked.
  assert.equal(accountReady({ ...valid, city: "", country: "" }), true);
  assert.equal(accountReady({ ...valid, avatarUrl: "" }), true);
});
