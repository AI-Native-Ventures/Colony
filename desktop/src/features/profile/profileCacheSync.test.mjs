import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient } from "@tanstack/react-query";

import { readSelfProfileCache } from "./lib/selfProfileStorage.ts";
import { readCachedUserLabels } from "./lib/userLabelStorage.ts";
import { refreshProfileCaches } from "./profileCacheSync.ts";

function installBrowserStubs() {
  const values = new Map();
  globalThis.window = {
    dispatchEvent() {},
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
      key: (index) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    },
  };
  globalThis.CustomEvent = class CustomEvent {};
  globalThis.fetch = async () => ({ ok: false });
}

const PUBKEY = "abcdef";
const RELAY_URL = "wss://relay.example";
const PROFILE = {
  pubkey: PUBKEY,
  displayName: "Alice",
  avatarUrl: "https://cdn.example/avatar.png",
  about: "About Alice",
  nip05Handle: null,
  ownerPubkey: null,
  hasProfileEvent: true,
};

test("successful deferred save synchronizes every profile cache", async () => {
  installBrowserStubs();
  const queryClient = new QueryClient();
  queryClient.setQueryData(["profile"], { ...PROFILE, avatarUrl: null });
  queryClient.setQueryData(["user-profile", PUBKEY], {
    ...PROFILE,
    avatarUrl: null,
  });
  queryClient.setQueryData(["users-batch-entry", PUBKEY], {
    summary: { displayName: "Alice", avatarUrl: null },
    fetchedAt: Date.now(),
  });
  queryClient.setQueryData(["users-batch", PUBKEY], {
    profiles: {
      [PUBKEY]: {
        displayName: "Alice",
        avatarUrl: null,
        nip05Handle: null,
        ownerPubkey: null,
      },
    },
    missing: [],
  });
  queryClient.setQueryData(
    ["user-search", "alice", 8],
    [{ pubkey: PUBKEY, displayName: "Alice", avatarUrl: null }],
  );

  await refreshProfileCaches(queryClient, PROFILE, RELAY_URL);

  assert.deepEqual(queryClient.getQueryData(["profile"]), PROFILE);
  assert.deepEqual(queryClient.getQueryData(["user-profile", PUBKEY]), PROFILE);
  assert.equal(
    queryClient.getQueryData(["users-batch", PUBKEY]).profiles[PUBKEY]
      .avatarUrl,
    PROFILE.avatarUrl,
  );
  assert.equal(
    queryClient.getQueryData(["users-batch-entry", PUBKEY]),
    undefined,
  );
  assert.equal(
    queryClient.getQueryState(["user-search", "alice", 8]).isInvalidated,
    true,
  );
  const persisted = readSelfProfileCache(RELAY_URL, PUBKEY);
  assert.equal(persisted.displayName, PROFILE.displayName);
  assert.equal(persisted.avatarUrl, PROFILE.avatarUrl);
  assert.equal(persisted.about, PROFILE.about);
  assert.equal(persisted.avatarDataUrl, null);
  assert.equal(persisted.hasProfileEvent, true);
  assert.ok(persisted.updatedAt > 0);
});

test("publishing the first name repairs cached missing authors and survives reopening", async () => {
  installBrowserStubs();
  const queryClient = new QueryClient();
  queryClient.setQueryData(["profile"], {
    ...PROFILE,
    displayName: "npub1missing",
    hasProfileEvent: false,
  });
  queryClient.setQueryData(["users-batch", PUBKEY], {
    profiles: {},
    missing: [PUBKEY],
  });
  queryClient.setQueryData(["users-batch-entry", PUBKEY], {
    summary: null,
    fetchedAt: Date.now(),
  });
  queryClient.setQueryData(
    ["channels", "welcome", "members"],
    [{ pubkey: PUBKEY, displayName: null }],
  );

  await refreshProfileCaches(
    queryClient,
    { ...PROFILE, avatarUrl: null },
    RELAY_URL,
  );

  const batch = queryClient.getQueryData(["users-batch", PUBKEY]);
  assert.equal(batch.profiles[PUBKEY].displayName, "Alice");
  assert.deepEqual(batch.missing, []);
  assert.equal(
    queryClient.getQueryData(["users-batch-entry", PUBKEY]),
    undefined,
  );
  assert.equal(
    queryClient.getQueryData(["channels", "welcome", "members"])[0].displayName,
    "Alice",
  );
  assert.equal(readSelfProfileCache(RELAY_URL, PUBKEY).displayName, "Alice");
  assert.equal(
    readCachedUserLabels(RELAY_URL, [PUBKEY]).profiles[PUBKEY].displayName,
    "Alice",
  );
});
