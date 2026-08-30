import assert from "node:assert/strict";
import test from "node:test";

import {
  answerAskInThread,
  buildThreadAnswerContent,
} from "./answerAskInThread.ts";

const FILER = "a".repeat(64);
const ORIGINAL_FILER = "b".repeat(64);

const threadedAsk = {
  id: "ask-1",
  askType: "decision",
  headline: "Approve the launch window",
  costOfDelay: null,
  filerPubkey: FILER,
  createdAt: 100,
  rawContent: "{}",
  channelId: "channel-1",
  threadId: "thread-1",
  originalFilerPubkey: null,
};

function deps(overrides = {}) {
  const calls = [];
  return {
    calls,
    sendChannelMessage: async (input) => {
      calls.push(["send", input]);
      return {
        eventId: "reply-1",
        parentEventId: input.parentEventId,
        rootEventId: input.parentEventId,
        depth: 1,
        createdAt: 200,
      };
    },
    invalidateQueries: async (queryKey) => {
      calls.push(["invalidate", queryKey]);
    },
    ...overrides,
  };
}

test("buildThreadAnswerContent joins decision and rationale with a blank line", () => {
  assert.equal(
    buildThreadAnswerContent({ decision: "Ship it", rationale: "It's ready" }),
    "Ship it\n\nIt's ready",
  );
});

test("buildThreadAnswerContent drops the blank line when rationale is empty", () => {
  assert.equal(
    buildThreadAnswerContent({ decision: "Ship it", rationale: "" }),
    "Ship it",
  );
});

test("posts an ordinary channel message into the ask's origin thread, no resolution card", async () => {
  const input = deps();
  await answerAskInThread(
    threadedAsk,
    { decision: "Ship it", rationale: "It's ready" },
    input,
  );

  assert.deepEqual(input.calls[0], [
    "send",
    {
      channelId: "channel-1",
      content: "Ship it\n\nIt's ready",
      parentEventId: "thread-1",
      mentionPubkeys: [FILER],
    },
  ]);
});

test("mentions the original filer on a relay-promoted ask, not the relay", async () => {
  const promoted = {
    ...threadedAsk,
    filerPubkey: "relay-pubkey",
    originalFilerPubkey: ORIGINAL_FILER,
  };
  const input = deps();
  await answerAskInThread(
    promoted,
    { decision: "Ship it", rationale: "" },
    input,
  );
  assert.deepEqual(input.calls[0]?.[1]?.mentionPubkeys, [ORIGINAL_FILER]);
});

test("never publishes anything but invalidates the same queries a card resolution does", async () => {
  const input = deps();
  await answerAskInThread(
    threadedAsk,
    { decision: "Ship it", rationale: "" },
    input,
  );

  assert.deepEqual(
    input.calls.slice(1).map((call) => call[1]),
    [["open-asks"], ["open-ask-closures"], ["ask-states"]],
  );
});

test("does not invalidate when the send fails", async () => {
  const input = deps({
    sendChannelMessage: async () => {
      throw new Error("send failed");
    },
  });

  await assert.rejects(
    answerAskInThread(
      threadedAsk,
      { decision: "Ship it", rationale: "" },
      input,
    ),
    /send failed/,
  );
  assert.deepEqual(input.calls, []);
});
