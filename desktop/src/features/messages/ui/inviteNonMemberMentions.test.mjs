import assert from "node:assert/strict";
import test from "node:test";

import { inviteNonMemberMentions } from "./inviteNonMemberMentions.ts";

const HUMAN = "a".repeat(64);
const AGENT = "b".repeat(64);

function pending(overrides = {}) {
  return {
    capturedChannelId: "channel-1",
    mentionPubkeys: [HUMAN],
    nonMemberPubkeys: [HUMAN, AGENT],
    outgoingTags: [["mention", HUMAN]],
    ...overrides,
  };
}

test("invites people and relay agents with their matching roles before send", async () => {
  const calls = [];
  let completed = null;
  const error = await inviteNonMemberMentions({
    pending: pending(),
    getManagedAgentsByPubkey: async () => new Map(),
    isAgentPubkey: (pubkey) => pubkey === AGENT,
    addMembers: async (input) => {
      calls.push(input);
      return { errors: [] };
    },
    completeSend: async (...args) => {
      completed = args;
    },
  });

  assert.equal(error, null);
  assert.deepEqual(calls, [
    { channelId: "channel-1", pubkeys: [HUMAN], role: "member" },
    { channelId: "channel-1", pubkeys: [AGENT], role: "bot" },
  ]);
  assert.deepEqual(completed?.[1], [HUMAN, AGENT]);
  assert.deepEqual(completed?.[2], []);
});

test("an invitation error prevents the original message from starting", async () => {
  let completed = false;
  const error = await inviteNonMemberMentions({
    pending: pending({
      mentionPubkeys: [HUMAN],
      nonMemberPubkeys: [HUMAN],
    }),
    getManagedAgentsByPubkey: async () => new Map(),
    isAgentPubkey: (pubkey) => pubkey === AGENT,
    addMembers: async () => ({ errors: [{ error: "membership refused" }] }),
    completeSend: async () => {
      completed = true;
    },
  });

  assert.equal(error, "membership refused");
  assert.equal(completed, false);
});
