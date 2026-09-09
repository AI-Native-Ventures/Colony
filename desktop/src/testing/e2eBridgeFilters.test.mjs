import assert from "node:assert/strict";
import test from "node:test";
import { selectMockChannelHistory } from "./e2eBridgeFilters.ts";

const owner = "a".repeat(64);
const root = {
  id: "0".repeat(64),
  pubkey: owner,
  kind: 9,
  created_at: 100,
  content: "Setup suggestion",
  tags: [["h", "welcome"]],
  sig: "0".repeat(128),
};
const instruction = {
  ...root,
  id: "f".repeat(64),
  content: "Ask Sarah to do the work",
  tags: [
    ["h", "welcome"],
    ["e", root.id, "", "reply"],
  ],
};

test("lost-receipt lookup returns the requested instruction when a same-second root sorts first", () => {
  const events = [instruction, root];
  const scope = { kinds: [9], authors: [owner], "#h": ["welcome"], limit: 1 };
  // Positive control: without an id constraint the root wins this real tie.
  assert.deepEqual(selectMockChannelHistory(events, scope), [root]);
  assert.deepEqual(
    selectMockChannelHistory(events, { ...scope, ids: [instruction.id] }),
    [instruction],
  );
  assert.deepEqual(
    selectMockChannelHistory(events, { ...scope, ids: ["c".repeat(64)] }),
    [],
  );
  assert.deepEqual(events, [instruction, root]);
});

test("receipt lookup never substitutes another author or channel before applying the limit", () => {
  const events = [
    { ...instruction, created_at: 102, pubkey: "b".repeat(64) },
    { ...instruction, created_at: 101, tags: [["h", "other-business"]] },
    instruction,
  ];
  const filter = {
    ids: [instruction.id],
    kinds: [9],
    authors: [owner],
    "#h": ["welcome"],
    limit: 1,
  };
  assert.deepEqual(selectMockChannelHistory(events, filter), [instruction]);
  assert.deepEqual(selectMockChannelHistory(events.slice(0, 2), filter), []);
});
