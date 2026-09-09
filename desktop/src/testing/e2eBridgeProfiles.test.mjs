import assert from "node:assert/strict";
import test from "node:test";
import { createProfileHandlers } from "./e2eBridgeProfiles.ts";

function fixture() {
  const profile = {
    pubkey: "synthetic-owner",
    display_name: null,
    avatar_url: null,
    about: "Owner-authored biography",
    nip05_handle: null,
    owner_pubkey: null,
    has_profile_event: false,
  };
  const names = [];
  const handlers = createProfileHandlers({
    getIdentity: () => undefined,
    ensureMockProfile: () => profile,
    getMockMemberPubkey: () => profile.pubkey,
    getMockProfileByPubkey: (pubkey) =>
      pubkey === profile.pubkey ? profile : null,
    applyMockDisplayName: (...args) => names.push(args),
    queryProfile: async () => {
      throw new Error("Unexpected relay query");
    },
    publishProfile: async () => {
      throw new Error("Unexpected relay publish");
    },
  });
  return { profile, names, ...handlers };
}

test("a successful profile write is observable as a saved event through both read commands", async () => {
  const api = fixture();
  assert.equal((await api.handleGetProfile()).has_profile_event, false);
  const written = await api.handleUpdateProfile({ displayName: "Owner Name" });
  assert.equal(written.has_profile_event, true);
  assert.notEqual(written, api.profile);
  assert.deepEqual(await api.handleGetProfile(), written);
  assert.deepEqual(
    await api.handleGetUserProfile({ pubkey: api.profile.pubkey }),
    written,
  );
  assert.deepEqual(api.names, [[api.profile.pubkey, "Owner Name"]]);
  const cleared = await api.handleUpdateProfile({ displayName: "" });
  assert.equal(cleared.display_name, null);
  assert.equal(cleared.has_profile_event, true);
});

test("name seeding preserves an existing named event while ordinary owner edits still work", async () => {
  const api = fixture();
  await api.handleUpdateProfile({ displayName: "Newer Owner Name" });
  const saved = await api.handleGetProfile();
  assert.deepEqual(
    await api.handleUpdateProfile({
      displayName: "Stale Name",
      displayNameIfMissing: true,
    }),
    saved,
  );
  assert.equal(api.names.length, 1);
  assert.equal(
    (await api.handleUpdateProfile({ displayName: "Owner Edit" })).display_name,
    "Owner Edit",
  );
  assert.equal(api.profile.about, "Owner-authored biography");
});

test("a failed write does not claim a saved profile and the configured retry remains usable", async () => {
  const api = fixture();
  const config = { mock: { profileUpdateError: "Synthetic write failed" } };
  await assert.rejects(
    api.handleUpdateProfile({ displayName: "Owner Name" }, config),
    /Synthetic write failed/,
  );
  assert.equal(api.profile.has_profile_event, false);
  assert.equal(api.profile.display_name, null);
  assert.equal(
    (await api.handleUpdateProfile({ displayName: "Owner Name" }, config))
      .has_profile_event,
    true,
  );
});
