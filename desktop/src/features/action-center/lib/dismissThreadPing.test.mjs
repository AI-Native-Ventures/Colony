import assert from "node:assert/strict";
import test from "node:test";

import { PING_DISMISS_EMOJI, dismissThreadPing } from "./dismissThreadPing.ts";
import { THREAD_PINGS_QUERY_KEY } from "./threadPings.ts";

test("dismissal publishes a kind:7 reaction targeting the ping event with the dismiss emoji", async () => {
  const calls = [];
  await dismissThreadPing(
    { id: "ping-1" },
    {
      addReaction: async (eventId, emoji) => {
        calls.push({ eventId, emoji });
      },
      invalidateQueries: async () => {},
    },
  );

  assert.deepEqual(calls, [{ eventId: "ping-1", emoji: PING_DISMISS_EMOJI }]);
  assert.equal(PING_DISMISS_EMOJI, "✅");
});

test("dismissal invalidates the thread-pings query so the item leaves the queue on refetch", async () => {
  const invalidated = [];
  await dismissThreadPing(
    { id: "ping-1" },
    {
      addReaction: async () => {},
      invalidateQueries: async (queryKey) => {
        invalidated.push(queryKey);
      },
    },
  );

  assert.deepEqual(invalidated, [THREAD_PINGS_QUERY_KEY]);
});

test("the reaction publish is awaited before invalidation fires", async () => {
  const order = [];
  await dismissThreadPing(
    { id: "ping-1" },
    {
      addReaction: async () => {
        order.push("reaction");
      },
      invalidateQueries: async () => {
        order.push("invalidate");
      },
    },
  );

  assert.deepEqual(order, ["reaction", "invalidate"]);
});

test("a failed reaction publish propagates and never invalidates", async () => {
  const invalidated = [];
  await assert.rejects(
    dismissThreadPing(
      { id: "ping-1" },
      {
        addReaction: async () => {
          throw new Error("relay rejected the event");
        },
        invalidateQueries: async (queryKey) => {
          invalidated.push(queryKey);
        },
      },
    ),
    /relay rejected the event/,
  );
  assert.deepEqual(invalidated, []);
});
