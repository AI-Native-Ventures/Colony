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

test("fresh marker + no completion + no own community = founder", () => {
  const storage = memoryStorage();
  markFreshIdentity("pk1", storage);
  assert.equal(
    isFreshFounder({ pubkey: "pk1", hasOwnCommunity: false, storage }),
    true,
  );
});

test("no marker (imported identity) is never a fresh founder", () => {
  const storage = memoryStorage();
  assert.equal(
    isFreshFounder({ pubkey: "pk1", hasOwnCommunity: false, storage }),
    false,
  );
});

test("a completed pubkey is never a fresh founder", () => {
  const storage = memoryStorage({
    "buzz-onboarding-complete.v1:pk1": "true",
  });
  markFreshIdentity("pk1", storage);
  assert.equal(
    isFreshFounder({ pubkey: "pk1", hasOwnCommunity: false, storage }),
    false,
  );
});

test("this pubkey already having its own community suppresses the canvas run", () => {
  const storage = memoryStorage();
  markFreshIdentity("pk1", storage);
  assert.equal(
    isFreshFounder({ pubkey: "pk1", hasOwnCommunity: true, storage }),
    false,
  );
});

// Regression test: this is the exact bug the owner reported. A second,
// genuinely new identity on a machine that already carries a DIFFERENT
// identity's community must still be a fresh founder. Fails against the
// previous machine-wide `communitiesCount > 0` check, which had no way to
// express "not this pubkey's community."
test("another identity's existing community does not suppress this pubkey's canvas run", () => {
  const storage = memoryStorage();
  markFreshIdentity("pk2", storage);
  assert.equal(
    isFreshFounder({ pubkey: "pk2", hasOwnCommunity: false, storage }),
    true,
  );
});

test("null pubkey is never a fresh founder", () => {
  assert.equal(
    isFreshFounder({
      pubkey: null,
      hasOwnCommunity: false,
      storage: memoryStorage(),
    }),
    false,
  );
});
