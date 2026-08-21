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
