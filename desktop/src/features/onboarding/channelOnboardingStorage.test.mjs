import assert from "node:assert/strict";
import test from "node:test";

import {
  channelOnboardingStorageKey,
  createChannelOnboardingStore,
} from "./channelOnboardingStorage.ts";

const scope = {
  ownerPubkey: "a".repeat(64),
  relayUrl: "wss://example.test",
  channelId: "welcome",
  threadRootId: "b".repeat(64),
  requestId: "signup-1",
};

function fixture() {
  const values = new Map();
  const lockNames = [];
  const store = createChannelOnboardingStore(
    {
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key),
      },
      withLock: async (name, work) => {
        lockNames.push(name);
        return work();
      },
    },
    "attempt",
    (value) =>
      typeof value === "object" && value !== null && value.kind === "attempt",
  );
  return { values, lockNames, store };
}

test("durable setup storage is scoped by the complete owner, relay, channel, root, and signup tuple", async () => {
  const f = fixture();
  f.store.write(scope, { kind: "attempt" });
  assert.deepEqual(f.store.read(scope), { kind: "attempt" });
  assert.match(channelOnboardingStorageKey(scope, "attempt"), /signup-1/);
  assert.notEqual(
    channelOnboardingStorageKey(scope, "attempt"),
    channelOnboardingStorageKey({ ...scope, requestId: "signup-2" }, "attempt"),
  );
  await f.store.withLock(scope, async () => "locked");
  assert.equal(f.lockNames.length, 1);
  assert.equal(f.lockNames[0], channelOnboardingStorageKey(scope, "attempt"));
});

test("malformed durable state fails closed instead of looking absent", () => {
  const f = fixture();
  const key = channelOnboardingStorageKey(scope, "attempt");
  f.values.set(key, JSON.stringify({ version: 1, scope, value: {} }));
  assert.throws(() => f.store.read(scope), /has not started another request/);
  f.values.set(key, "not json");
  assert.throws(() => f.store.read(scope), /has not started another request/);
});
