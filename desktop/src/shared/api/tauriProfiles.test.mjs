import assert from "node:assert/strict";
import test from "node:test";
import { setNativeBridge } from "@/shared/api/nativeBridge";
import { createMockNativeBridge } from "@/testing/createMockNativeBridge";
import { updateProfile } from "./tauriProfiles.ts";

const owner = "a".repeat(64);
const rawProfile = {
  pubkey: owner,
  display_name: "Owner at Horizon",
  avatar_url: null,
  about: null,
  nip05_handle: null,
  owner_pubkey: null,
  has_profile_event: true,
};

test("public-name carry pins its scope and returns a newer target name unchanged", async () => {
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      assert.equal(command, "update_profile");
      assert.deepEqual(args, {
        displayName: "Owner at Colony",
        expectedPubkey: owner,
        expectedRelayUrl: "wss://horizon.test",
        displayNameIfMissing: true,
      });
      return rawProfile;
    }),
  );
  const result = await updateProfile(
    { displayName: "Owner at Colony" },
    {
      pubkey: owner,
      relayUrl: "wss://horizon.test",
      displayNameIfMissing: true,
    },
  );
  assert.equal(result.displayName, "Owner at Horizon");
});

test("ordinary profile edits do not request conditional seeding", async () => {
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      assert.equal(command, "update_profile");
      assert.deepEqual(args, { displayName: "My changed name" });
      return { ...rawProfile, display_name: "My changed name" };
    }),
  );
  assert.equal(
    (await updateProfile({ displayName: "My changed name" })).displayName,
    "My changed name",
  );
});
