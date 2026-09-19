import assert from "node:assert/strict";
import test from "node:test";

import { buildTranscript } from "./agentSessionTranscript.ts";
import {
  chainExhaustedFailure,
  effectiveModelChain,
  turnServedModelNote,
} from "./agentTurnModelNote.ts";

const PRIMARY = "z/primary:free";
const CHAIN = [PRIMARY, "a/one:free", "b/two:free"];

test("the effective chain is the agent's own model, then its fallbacks", () => {
  assert.deepEqual(
    effectiveModelChain(PRIMARY, ["a/one:free", "b/two:free"]),
    CHAIN,
  );
  // A fallback repeating the primary is one model, not two positions.
  assert.deepEqual(effectiveModelChain(PRIMARY, [PRIMARY, "a/one:free"]), [
    PRIMARY,
    "a/one:free",
  ]);
  assert.deepEqual(effectiveModelChain("  ", ["", " a/one:free "]), [
    "a/one:free",
  ]);
});

test("a reply served by the agent's own model says nothing", () => {
  assert.equal(
    turnServedModelNote({ chain: CHAIN, servedModel: PRIMARY }),
    null,
  );
  assert.equal(turnServedModelNote({ chain: CHAIN, servedModel: "" }), null);
  assert.equal(
    turnServedModelNote({ chain: CHAIN, servedModel: undefined }),
    null,
  );
});

test("a reply served by a fallback names it and its position", () => {
  assert.equal(
    turnServedModelNote({ chain: CHAIN, servedModel: "a/one:free" }),
    "Answered by a/one:free, fallback 1 of 2",
  );
  assert.equal(
    turnServedModelNote({ chain: CHAIN, servedModel: "b/two:free" }),
    "Answered by b/two:free, fallback 2 of 2",
  );
});

test("a served model outside the chain is named without a position", () => {
  // The chain the desktop resolved is not always the one the harness ran, so
  // claiming a position here would be inventing one.
  assert.equal(
    turnServedModelNote({ chain: CHAIN, servedModel: "c/three:free" }),
    "Answered by c/three:free",
  );
  assert.equal(
    turnServedModelNote({ chain: [], servedModel: "c/three:free" }),
    "Answered by c/three:free",
  );
});

test("an exhausted chain replaces the provider's body with what was tried", () => {
  assert.deepEqual(
    chainExhaustedFailure({
      chain: CHAIN,
      message: "error: exhausted retries: 503: upstream is unavailable",
    }),
    { ids: CHAIN, text: "All 3 models failed" },
  );
  assert.deepEqual(
    chainExhaustedFailure({ chain: CHAIN, message: "llm: fell back" }),
    { ids: CHAIN, text: "All 3 models failed" },
  );
});

test("an ordinary turn error keeps its own text", () => {
  assert.equal(
    chainExhaustedFailure({
      chain: CHAIN,
      message: "error: 401: static key rejected",
    }),
    null,
  );
  // One model and no fallbacks cannot exhaust a chain.
  assert.equal(
    chainExhaustedFailure({
      chain: [PRIMARY],
      message: "exhausted retries: 503",
    }),
    null,
  );
});

function usageEvent(model) {
  return {
    seq: 2,
    timestamp: "2026-09-15T12:00:01Z",
    kind: "acp_read",
    agentIndex: 0,
    channelId: "channel-1",
    sessionId: "session-1",
    turnId: "turn-1",
    payload: {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-1",
        update: {
          sessionUpdate: "usage_update",
          used: 1000,
          size: 200000,
          model,
        },
      },
    },
  };
}

const REPLY_EVENT = {
  seq: 1,
  timestamp: "2026-09-15T12:00:00Z",
  kind: "acp_read",
  agentIndex: 0,
  channelId: "channel-1",
  sessionId: "session-1",
  turnId: "turn-1",
  payload: {
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Here is the answer." },
      },
    },
  },
};

test("the usage payload's model lands on the reply it describes", () => {
  const items = buildTranscript([REPLY_EVENT, usageEvent("a/one:free")]);
  const reply = items.find(
    (item) => item.type === "message" && item.role === "assistant",
  );
  assert.equal(reply?.servedModel, "a/one:free");
  assert.equal(
    turnServedModelNote({ chain: CHAIN, servedModel: reply?.servedModel }),
    "Answered by a/one:free, fallback 1 of 2",
  );
});

test("a usage payload without a model leaves the reply alone", () => {
  const items = buildTranscript([REPLY_EVENT, usageEvent(undefined)]);
  const reply = items.find(
    (item) => item.type === "message" && item.role === "assistant",
  );
  assert.ok(reply, "the reply itself must still be there");
  assert.equal(reply?.servedModel ?? null, null);
  // The Usage line the pane already had is untouched.
  assert.ok(
    items.some((item) => item.title === "Usage"),
    "the usage lifecycle line must survive the model plumbing",
  );
});
