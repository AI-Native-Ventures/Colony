import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isBuiltInChiefOfStaff,
  isChiefOfStaffAgent,
  isProvisionedChiefOfStaff,
  pickChiefOfStaff,
} from "./provisionedChief.ts";

const PROVISIONED = "c".repeat(64);
const BUILT_IN = "a".repeat(64);
const OTHER = "b".repeat(64);

const provisionedChief = {
  pubkey: PROVISIONED,
  personaId: null,
  provisioned: "chief-of-staff",
  name: "Chief of Staff",
};
const builtInChief = {
  pubkey: BUILT_IN,
  personaId: "builtin:fizz",
  provisioned: null,
  name: "Scout",
};
const engineer = {
  pubkey: OTHER,
  personaId: "builtin:honey",
  provisioned: null,
  name: "Forager",
};

test("the provisioned record is recognised by its handle, not its persona", () => {
  assert.equal(isProvisionedChiefOfStaff(provisionedChief), true);
  assert.equal(isBuiltInChiefOfStaff(provisionedChief), false);
  assert.equal(isChiefOfStaffAgent(provisionedChief), true);
});

test("the built-in instance is still recognised as a chief of staff", () => {
  assert.equal(isBuiltInChiefOfStaff(builtInChief), true);
  assert.equal(isProvisionedChiefOfStaff(builtInChief), false);
  assert.equal(isChiefOfStaffAgent(builtInChief), true);
});

test("an ordinary agent is neither", () => {
  assert.equal(isChiefOfStaffAgent(engineer), false);
});

test("the provisioned record wins where both exist", () => {
  // The duplicate the roster was showing: two Chiefs of Staff in one
  // community. Order must not decide which one a lookup returns.
  assert.equal(
    pickChiefOfStaff([builtInChief, provisionedChief])?.pubkey,
    PROVISIONED,
  );
  assert.equal(
    pickChiefOfStaff([provisionedChief, builtInChief])?.pubkey,
    PROVISIONED,
  );
});

test("the built-in instance still holds the office where no provisioned record exists", () => {
  assert.equal(pickChiefOfStaff([engineer, builtInChief])?.pubkey, BUILT_IN);
});

test("a community with neither resolves to nobody", () => {
  assert.equal(pickChiefOfStaff([engineer]), null);
  assert.equal(pickChiefOfStaff(undefined), null);
});
