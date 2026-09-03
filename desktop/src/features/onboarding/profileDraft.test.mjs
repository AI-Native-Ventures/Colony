import assert from "node:assert/strict";
import test from "node:test";

import {
  createProfileUpdatePayload,
  resolveSavedProfile,
  sanitizeDisplayName,
} from "./profileDraft.ts";

test("profile_draft_treats_an_npub_as_no_name", () => {
  assert.equal(sanitizeDisplayName("npub1abc"), "");
  assert.equal(sanitizeDisplayName("nostr:npub1abc"), "");
  assert.equal(sanitizeDisplayName("  Aisha Bello "), "Aisha Bello");
});

test("profile_draft_seeds_from_the_relay_profile", () => {
  assert.deepEqual(
    resolveSavedProfile({ displayName: "Aisha", avatarUrl: "https://a/b.png" }),
    { displayName: "Aisha", avatarUrl: "https://a/b.png" },
  );
  assert.deepEqual(resolveSavedProfile(null), {
    displayName: "",
    avatarUrl: "",
  });
});

test("profile_draft_writes_only_what_changed", () => {
  const savedProfile = { displayName: "Aisha", avatarUrl: "https://a/b.png" };
  assert.deepEqual(
    createProfileUpdatePayload({ draftProfile: savedProfile, savedProfile }),
    {},
  );
  assert.deepEqual(
    createProfileUpdatePayload({
      draftProfile: { ...savedProfile, displayName: "Aisha B" },
      savedProfile,
    }),
    { displayName: "Aisha B" },
  );
});

test("profile_draft_never_clears_a_saved_field_by_emptying_it", () => {
  assert.deepEqual(
    createProfileUpdatePayload({
      draftProfile: { displayName: "", avatarUrl: "" },
      savedProfile: { displayName: "Aisha", avatarUrl: "https://a/b.png" },
    }),
    {},
  );
});
