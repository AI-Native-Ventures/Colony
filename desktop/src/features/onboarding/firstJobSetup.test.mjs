import assert from "node:assert/strict";
import test from "node:test";
import {
  allowLegacyFirstJobKickoff,
  createFirstJobSetupStore,
  firstJobSetupKey,
  suppressLegacyFirstJobKickoff,
} from "./firstJobSetup.ts";
import {
  firstJobSuggestionTag,
  FIRST_JOB_SUGGESTION_MARKER,
} from "./firstJobSuggestion.ts";
const scope = { ownerPubkey: "a".repeat(64), relayUrl: "wss://example.test" };
const memory = () => {
  const map = new Map();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
  };
};
test("explicit Start is durable and exact-owner/exact-relay isolated", () => {
  const storage = memory();
  let changes = 0;
  const store = createFirstJobSetupStore(storage, () => changes++);
  assert.equal(store.read(scope), "legacy");
  store.mark(scope);
  assert.equal(changes, 1);
  assert.equal(createFirstJobSetupStore(storage).read(scope), "explicit");
  assert.equal(store.read({ ...scope, ownerPubkey: "b".repeat(64) }), "legacy");
  assert.equal(
    store.read({ ...scope, relayUrl: "wss://other.test" }),
    "legacy",
  );
});
test("failed reads and malformed flags cannot enable automatic kickoff", () => {
  const store = createFirstJobSetupStore({
    getItem: () => {
      throw Error("storage unavailable");
    },
    setItem() {},
  });
  assert.equal(store.read(scope), "unavailable");
  const storage = memory();
  storage.setItem(firstJobSetupKey(scope), "bad");
  assert.equal(createFirstJobSetupStore(storage).read(scope), "unavailable");
  assert.equal(
    suppressLegacyFirstJobKickoff(
      "unavailable",
      { ...scope, channelId: "welcome" },
      [],
    ),
    true,
  );
});
test("lost writes cannot appear successful or notify subscribers", () => {
  let changes = 0;
  const store = createFirstJobSetupStore(
    { getItem: () => null, setItem() {} },
    () => changes++,
  );
  assert.throws(() => store.mark(scope), /could not save/);
  assert.equal(changes, 0);
});
test("an accepted scoped suggestion suppresses legacy kickoff without granting unrelated accounts authority", () => {
  const current = { ...scope, channelId: "welcome" };
  const payload = {
    version: 1,
    ...current,
    requestId: "req1",
    businessName: "Horizon",
    business: "Branding",
    website: "",
    brief: "Review three ideas",
  };
  const event = {
    id: "c".repeat(64),
    kind: 9,
    pubkey: scope.ownerPubkey,
    tags: [["h", "welcome"], firstJobSuggestionTag(payload)],
  };
  assert.equal(suppressLegacyFirstJobKickoff("legacy", current, [event]), true);
  assert.equal(
    suppressLegacyFirstJobKickoff(
      "legacy",
      { ...current, ownerPubkey: "b".repeat(64) },
      [event],
    ),
    false,
  );
  assert.equal(
    suppressLegacyFirstJobKickoff(
      "legacy",
      { ...current, relayUrl: "wss://other.test" },
      [event],
    ),
    false,
  );
  assert.equal(
    suppressLegacyFirstJobKickoff("legacy", current, [
      { ...event, tags: [...event.tags, ["e", "reply"]] },
    ]),
    false,
  );
});
test("legacy history must finish without a suggestion before automatic kickoff is allowed", async () => {
  assert.equal(await allowLegacyFirstJobKickoff(async () => []), true);
  assert.equal(
    await allowLegacyFirstJobKickoff(async () => [
      { tags: [["client", FIRST_JOB_SUGGESTION_MARKER]] },
    ]),
    false,
  );
  assert.equal(
    await allowLegacyFirstJobKickoff(async () =>
      Array.from({ length: 500 }, () => ({ tags: [] })),
    ),
    false,
  );
  assert.equal(
    await allowLegacyFirstJobKickoff(async () => {
      throw Error("offline");
    }),
    false,
  );
});
