import assert from "node:assert/strict";
import test from "node:test";

import { revalidateAgentMentionPubkeys } from "./agentMentionRevalidation.ts";

const CURRENT = "a".repeat(64);
const AGENT = "b".repeat(64);
const HUMAN = "c".repeat(64);
const LOCAL_AGENT = "e".repeat(64);
const OTHER_OWNER = "d".repeat(64);

function options() {
  return {
    pubkeys: [HUMAN, AGENT],
    agentPubkeys: new Set([AGENT]),
    currentPubkey: CURRENT,
    eligibilityScope: { type: "channel", channelId: "general" },
    sharedChannelIds: new Set(["general"]),
    refetchManagedAgents: async () => ({ data: [], error: null }),
    fetchRelayAgents: async () => [
      {
        pubkey: AGENT,
        respondTo: "anyone",
        respondToAllowlist: [],
        channelIds: ["general"],
      },
    ],
  };
}

test("relay policy revalidation admits an authorized external agent", async () => {
  assert.deepEqual(await revalidateAgentMentionPubkeys(options()), [
    HUMAN,
    AGENT,
  ]);
});

test("fresh managed evidence survives unrelated relay authorization errors", async () => {
  const result = await revalidateAgentMentionPubkeys({
    ...options(),
    pubkeys: [HUMAN, LOCAL_AGENT],
    agentPubkeys: new Set([LOCAL_AGENT]),
    refetchManagedAgents: async () => ({
      data: [{ pubkey: LOCAL_AGENT }],
      error: null,
    }),
    fetchRelayAgents: async () => {
      throw new Error("relay directory unavailable");
    },
  });

  assert.deepEqual(result, [HUMAN, LOCAL_AGENT]);
});

test("relay-only agents still fail closed when relay discovery fails", async () => {
  const result = await revalidateAgentMentionPubkeys({
    ...options(),
    fetchRelayAgents: async () => {
      throw new Error("relay directory unavailable");
    },
  });

  assert.deepEqual(result, [HUMAN]);
});

test("mixed evidence preserves only fresh managed agents and humans", async () => {
  const result = await revalidateAgentMentionPubkeys({
    ...options(async () => ({
      profiles: { [AGENT]: { ownerPubkey: CURRENT } },
      missing: [LOCAL_AGENT],
    })),
    pubkeys: [HUMAN, LOCAL_AGENT, AGENT],
    agentPubkeys: new Set([LOCAL_AGENT, AGENT]),
    refetchManagedAgents: async () => ({
      data: [{ pubkey: LOCAL_AGENT }],
      error: null,
    }),
    fetchRelayAgents: async () => {
      throw new Error("relay directory unavailable");
    },
  });

  assert.deepEqual(result, [HUMAN, LOCAL_AGENT]);
});

test("an intended agent that is no longer admitted fails the send", async () => {
  await assert.rejects(
    revalidateAgentMentionPubkeys({
      ...options(),
      fetchRelayAgents: async () => [
        {
          pubkey: AGENT,
          ownerPubkey: OTHER_OWNER,
          respondTo: "owner-only",
          respondToAllowlist: [],
          channelIds: ["general"],
        },
      ],
      intendedAgentPubkeys: [AGENT],
    }),
    (error) => error.name === "AgentMentionAuthorizationError",
  );
});

test("a stale key nobody intended is filtered out quietly", async () => {
  const result = await revalidateAgentMentionPubkeys({
    ...options(),
    fetchRelayAgents: async () => [
      {
        pubkey: AGENT,
        ownerPubkey: OTHER_OWNER,
        respondTo: "owner-only",
        respondToAllowlist: [],
        channelIds: ["general"],
      },
    ],
  });

  assert.deepEqual(result, [HUMAN]);
});

test("prepare admits an owner's own shared agent before the channel exists", async () => {
  const result = await revalidateAgentMentionPubkeys({
    ...options(),
    phase: "prepare",
    eligibilityScope: { type: "owned", channelId: null },
    fetchRelayAgents: async () => [
      {
        pubkey: AGENT,
        ownerPubkey: CURRENT,
        respondTo: "owner-only",
        respondToAllowlist: [],
        channelIds: ["general"],
      },
    ],
    intendedAgentPubkeys: [AGENT],
  });

  assert.deepEqual(result, [HUMAN, AGENT]);
});
