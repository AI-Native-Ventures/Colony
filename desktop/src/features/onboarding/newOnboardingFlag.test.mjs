// desktop/src/features/onboarding/newOnboardingFlag.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { invitesEnabled, isNewOnboardingEnabled } from "./newOnboardingFlag.ts";

test("flag_defaults_to_the_existing_flow", () => {
  assert.equal(isNewOnboardingEnabled({}), false);
});

test("flag_turns_on_explicitly", () => {
  assert.equal(isNewOnboardingEnabled({ VITE_NEW_ONBOARDING: "1" }), true);
});

test("invites_stay_off_until_the_download_button_is_back", () => {
  // An invite link with no app to download is a dead end for the recipient.
  assert.equal(invitesEnabled({ VITE_NEW_ONBOARDING: "1" }), false);
  assert.equal(
    invitesEnabled({ VITE_NEW_ONBOARDING: "1", VITE_ONBOARDING_INVITES: "1" }),
    true,
  );
});

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
  };
}

test("e2e_override_turns_the_flag_on_in_the_e2e_mode_only", () => {
  const storage = fakeStorage({ "colony.e2e.newOnboarding": "1" });
  assert.equal(isNewOnboardingEnabled({ MODE: "e2e" }, storage), true);
  // The override is unreachable outside the e2e build mode, so a stray key
  // can never turn the flow on in production or dev.
  assert.equal(isNewOnboardingEnabled({ MODE: "production" }, storage), false);
  assert.equal(isNewOnboardingEnabled({ MODE: "development" }, storage), false);
});

test("e2e_override_needs_the_key_set", () => {
  assert.equal(isNewOnboardingEnabled({ MODE: "e2e" }, fakeStorage()), false);
});

test("e2e_override_survives_a_missing_storage_without_throwing", () => {
  // Node has no localStorage; the guard must fall back to null, not throw.
  assert.equal(isNewOnboardingEnabled({ MODE: "e2e" }, null), false);
  assert.equal(isNewOnboardingEnabled({ MODE: "e2e" }), false);
});

test("invites_honour_the_e2e_override_too", () => {
  const storage = fakeStorage({ "colony.e2e.newOnboarding": "1" });
  assert.equal(invitesEnabled({ MODE: "e2e" }, storage), false);
  assert.equal(
    invitesEnabled({ MODE: "e2e", VITE_ONBOARDING_INVITES: "1" }, storage),
    true,
  );
});
