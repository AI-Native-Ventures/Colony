import assert from "node:assert/strict";
import test from "node:test";

import { answerAsk } from "./answerAsk.ts";

const ask = {
  id: "ask-1",
  askType: "decision",
  headline: "Approve",
  costOfDelay: null,
  filerPubkey: "a".repeat(64),
  createdAt: 100,
  rawContent: "{}",
  channelId: null,
  threadId: null,
};

function deps(overrides = {}) {
  const calls = [];
  return {
    calls,
    signRelayEvent: async (input) => {
      calls.push(["sign", input]);
      return { id: "resolution-1", ...input };
    },
    publishEvent: async (...args) => {
      calls.push(["publish", ...args]);
    },
    invalidateQueries: async (queryKey) => {
      calls.push(["invalidate", queryKey]);
    },
    ...overrides,
  };
}

test("publishes an ask resolution and invalidates both open-ask queries", async () => {
  const input = deps();
  await answerAsk(ask, "approve", "Looks good", input);

  assert.deepEqual(input.calls[0], [
    "sign",
    {
      kind: 44301,
      content: JSON.stringify({
        answer: { decision: "approve", rationale: "Looks good" },
      }),
      tags: [["e", "ask-1"]],
    },
  ]);
  assert.equal(input.calls[1]?.[0], "publish");
  assert.deepEqual(
    input.calls.slice(2).map((call) => call[1]),
    [["open-asks"], ["open-ask-closures"]],
  );
});

test("does not invalidate when signing or publishing fails", async () => {
  const input = deps({
    signRelayEvent: async () => {
      throw new Error("signing failed");
    },
  });

  await assert.rejects(answerAsk(ask, "approve", "", input), /signing failed/);
  assert.deepEqual(input.calls, []);
});
