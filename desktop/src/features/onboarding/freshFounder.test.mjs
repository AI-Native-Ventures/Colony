import assert from "node:assert/strict";
import { test } from "node:test";

import { isFreshFounder, markFreshIdentity } from "./freshFounder.ts";

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

test("fresh marker + no completion + no communities = founder", () => {
  const storage = memoryStorage();
  markFreshIdentity("pk1", storage);
  assert.equal(
    isFreshFounder({ pubkey: "pk1", communitiesCount: 0, storage }),
    true,
  );
});

test("no marker (imported identity) is never a fresh founder", () => {
  const storage = memoryStorage();
  assert.equal(
    isFreshFounder({ pubkey: "pk1", communitiesCount: 0, storage }),
    false,
  );
});

test("a completed pubkey is never a fresh founder", () => {
  const storage = memoryStorage({
    "buzz-onboarding-complete.v1:pk1": "true",
  });
  markFreshIdentity("pk1", storage);
  assert.equal(
    isFreshFounder({ pubkey: "pk1", communitiesCount: 0, storage }),
    false,
  );
});

test("existing communities suppress the canvas run", () => {
  const storage = memoryStorage();
  markFreshIdentity("pk1", storage);
  assert.equal(
    isFreshFounder({ pubkey: "pk1", communitiesCount: 1, storage }),
    false,
  );
});

test("null pubkey is never a fresh founder", () => {
  assert.equal(
    isFreshFounder({
      pubkey: null,
      communitiesCount: 0,
      storage: memoryStorage(),
    }),
    false,
  );
});
