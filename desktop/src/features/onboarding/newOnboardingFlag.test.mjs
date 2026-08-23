// desktop/src/features/onboarding/newOnboardingFlag.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { invitesEnabled, isNewOnboardingEnabled } from "./newOnboardingFlag.ts";

test("flag_defaults_to_the_redesigned_flow", () => {
  assert.equal(isNewOnboardingEnabled({}), true);
  assert.equal(isNewOnboardingEnabled({ MODE: "production" }), true);
});

test("kill_switch_falls_back_to_the_previous_flow", () => {
  // The only reason the env var still exists: a release can drop back to the
  // old flow without shipping a code change.
  assert.equal(isNewOnboardingEnabled({ VITE_NEW_ONBOARDING: "0" }), false);
  assert.equal(
    isNewOnboardingEnabled({ MODE: "e2e", VITE_NEW_ONBOARDING: "0" }),
    false,
  );
});

test("flag_stays_on_when_set_explicitly", () => {
  assert.equal(isNewOnboardingEnabled({ VITE_NEW_ONBOARDING: "1" }), true);
});

test("invites_stay_off_until_the_download_button_is_back", () => {
  // An invite link with no app to download is a dead end for the recipient.
  assert.equal(invitesEnabled({}), false);
  assert.equal(invitesEnabled({ VITE_ONBOARDING_INVITES: "1" }), true);
});

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
  };
}

test("e2e_override_opts_a_spec_out_of_the_redesign", () => {
  const storage = fakeStorage({ "colony.e2e.newOnboarding": "0" });
  assert.equal(isNewOnboardingEnabled({ MODE: "e2e" }, storage), false);
  // The opt-out is unreachable outside the e2e build mode, so a stray key can
  // never turn the redesigned flow off in production or dev.
  assert.equal(isNewOnboardingEnabled({ MODE: "production" }, storage), true);
  assert.equal(isNewOnboardingEnabled({ MODE: "development" }, storage), true);
});

test("e2e_defaults_to_the_redesign_without_the_key", () => {
  assert.equal(isNewOnboardingEnabled({ MODE: "e2e" }, fakeStorage()), true);
});

test("e2e_override_survives_a_missing_storage_without_throwing", () => {
  // Node has no localStorage; the guard must fall back to null, not throw.
  assert.equal(isNewOnboardingEnabled({ MODE: "e2e" }, null), true);
  assert.equal(isNewOnboardingEnabled({ MODE: "e2e" }), true);
});

test("invites_honour_the_e2e_opt_out_too", () => {
  const storage = fakeStorage({ "colony.e2e.newOnboarding": "0" });
  assert.equal(
    invitesEnabled({ MODE: "e2e", VITE_ONBOARDING_INVITES: "1" }, storage),
    false,
  );
});
