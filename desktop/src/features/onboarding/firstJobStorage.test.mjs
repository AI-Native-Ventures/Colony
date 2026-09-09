import assert from "node:assert/strict";
import { test } from "node:test";
import { createFirstJobStore, firstJobStorageKey } from "./firstJobStorage.ts";

const scope = {
  ownerPubkey: "a".repeat(64),
  relayUrl: "wss://horizon.example",
  channelId: "welcome",
  threadRootId: "b".repeat(64),
  requestId: "attempt-1",
};
const valid = (value) => typeof value === "string";
function fixture(overrides = {}) {
  const values = new Map();
  const notices = [];
  const deps = {
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    withLock: async (_key, work) => work(),
    notify: (key) => notices.push(key),
    ...overrides,
  };
  return {
    store: createFirstJobStore(deps, "draft", valid),
    values,
    notices,
    deps,
  };
}

test("drafts survive a new store while owners, communities, roots and slots remain separate", () => {
  const { store, deps } = fixture();
  store.write(scope, "first draft");
  assert.equal(
    createFirstJobStore(deps, "draft", valid).read(scope),
    "first draft",
  );
  for (const change of [
    { ownerPubkey: "c".repeat(64) },
    { relayUrl: "wss://another.example" },
    { channelId: "other" },
    { threadRootId: "d".repeat(64) },
    { requestId: "attempt-2" },
  ])
    assert.equal(store.read({ ...scope, ...change }), null);
  assert.equal(createFirstJobStore(deps, "checkout", valid).read(scope), null);
});

test("invalid or unreadable persisted attempts never become an empty new attempt", () => {
  const { store, values } = fixture();
  const key = firstJobStorageKey(scope, "draft");
  for (const raw of [
    "{",
    "null",
    "{}",
    JSON.stringify({
      version: 1,
      scope: { ...scope, channelId: "other" },
      value: "draft",
    }),
  ]) {
    values.set(key, raw);
    assert.throws(() => store.read(scope), /could not read/);
  }
  const { store: denied } = fixture({
    storage: {
      getItem: () => {
        throw new Error("read denied");
      },
      setItem() {},
    },
  });
  assert.throws(() => denied.read(scope), /read denied/);
});

test("quota or silently ignored writes stop the next step and never notify success", () => {
  for (const setItem of [
    () => {},
    () => {
      throw new Error("quota");
    },
  ]) {
    const { store, notices } = fixture({
      storage: { getItem: () => null, setItem },
    });
    assert.throws(() => store.write(scope, "draft"), /could not save/);
    assert.equal(notices.length, 0);
  }
});

test("cross-window serialization uses the exact root and record slot", async () => {
  const locks = [];
  const { store } = fixture({
    withLock: async (key, work) => {
      locks.push(key);
      return work();
    },
  });
  assert.equal(await store.withLock(scope, async () => "done"), "done");
  assert.deepEqual(locks, [firstJobStorageKey(scope, "draft")]);
});

test("malformed scopes never reach storage", () => {
  const { store } = fixture({
    storage: {
      getItem() {
        assert.fail("invalid read");
      },
      setItem() {
        assert.fail("invalid write");
      },
    },
  });
  for (const change of [
    { ownerPubkey: "bad" },
    { threadRootId: "pending" },
    { channelId: "a/b" },
    { relayUrl: "wss://me:secret@example.com" },
  ]) {
    assert.throws(() => store.read({ ...scope, ...change }));
  }
});
