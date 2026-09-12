import assert from "node:assert/strict";
import test from "node:test";

import { createScoutReplyVerifier } from "./reply.ts";
import {
  approvalRequestId,
  ownerPubkey,
  rootEvent,
  scope,
  scoutPubkey,
  setupInput,
  signedAcknowledgement,
  signedReply,
} from "./testFixtures.mjs";

function observerEvent(id, createdAt) {
  return {
    id,
    pubkey: scoutPubkey,
    created_at: createdAt,
    kind: 24200,
    tags: [
      ["p", ownerPubkey],
      ["agent", scoutPubkey],
    ],
    content: "encrypted",
    sig: "f".repeat(128),
  };
}

function proofFrame(kind, turnId, seq, timestamp, payload = {}) {
  return {
    kind,
    turnId,
    channelId: scope.channelId,
    seq,
    timestamp,
    payload,
  };
}

function verifierFixture({ includeReply = true, timeoutMs = 500 } = {}) {
  const acknowledgement = signedAcknowledgement();
  const reply = signedReply(acknowledgement.id);
  const frames = [
    proofFrame(
      "turn_completed",
      "turn-1",
      3,
      "2026-09-12T10:00:03.000Z",
    ),
    proofFrame(
      "acp_read",
      "turn-1",
      2,
      "2026-09-12T10:00:02.000Z",
      { result: { stopReason: "end_turn" } },
    ),
    proofFrame(
      "turn_started",
      "turn-1",
      1,
      "2026-09-12T10:00:01.000Z",
      { triggeringEventIds: [acknowledgement.id] },
    ),
  ];
  const decoded = new Map([
    ["observer-newest", { kind: "batch", payload: { events: frames } }],
  ]);
  const callbacks = {};
  const unsubscribed = [];
  const filters = [];
  const verifier = createScoutReplyVerifier({
    timeoutMs,
    subscribeObserver: async (_owner, onEvent) => {
      callbacks.observer = onEvent;
      return () => unsubscribed.push("observer");
    },
    subscribeMessages: async (filter, onEvent) => {
      filters.push(filter);
      callbacks.message = onEvent;
      return () => unsubscribed.push("messages");
    },
    decryptObserver: async (event) => decoded.get(event.id),
    fetchReply: async (receivedScope, receivedScout, receivedAck) => {
      assert.equal(receivedScope.channelId, scope.channelId);
      assert.equal(receivedScout, scoutPubkey);
      assert.equal(receivedAck, acknowledgement.id);
      return includeReply ? reply : null;
    },
    readObserverHistory: async (owner, scout, afterCreatedAt) => {
      assert.equal(owner, scope.ownerPubkey);
      assert.equal(scout, scoutPubkey);
      assert.equal(afterCreatedAt, acknowledgement.created_at);
      return [observerEvent("observer-newest", acknowledgement.created_at + 3)];
    },
    assertCurrent: async () => {},
    now: () => 1_700_000_500_000,
  });
  return {
    verifier,
    acknowledgement,
    callbacks,
    filters,
    unsubscribed,
  };
}

function verificationInput(fixture) {
  return {
    scope,
    input: setupInput,
    requestId: approvalRequestId,
    scoutPubkey,
    acknowledgement: {
      eventId: fixture.acknowledgement.id,
      signedEvent: JSON.stringify(fixture.acknowledgement),
      published: true,
    },
    acknowledgementEvent: fixture.acknowledgement,
  };
}

test("delayed retry uses archived signed observer frames and orders replay before proving readiness", async () => {
  const f = verifierFixture();
  const proof = await f.verifier(verificationInput(f));

  assert.equal(proof.agentPubkey, scoutPubkey);
  assert.equal(proof.acknowledgementEventId, f.acknowledgement.id);
  assert.equal(proof.replyEventId, JSON.parse(proof.signedReplyEvent).id);
  assert.equal(proof.turnId, "turn-1");
  assert.deepEqual(f.filters[0]["#e"], [f.acknowledgement.id]);
  assert.deepEqual(f.unsubscribed.sort(), ["messages", "observer"]);
});

test("an unrelated or forged message cannot satisfy a real turn proof", async () => {
  const f = verifierFixture({ includeReply: false, timeoutMs: 35 });
  const forged = signedReply(f.acknowledgement.id, new Uint8Array(32).fill(6));
  f.verifier = createScoutReplyVerifier({
    timeoutMs: 35,
    subscribeObserver: async (_owner, onEvent) => {
      f.callbacks.observer = onEvent;
      return () => f.unsubscribed.push("observer");
    },
    subscribeMessages: async (_filter, onEvent) => {
      f.callbacks.message = onEvent;
      return () => f.unsubscribed.push("messages");
    },
    decryptObserver: async () => ({ kind: "batch", payload: { events: [] } }),
    fetchReply: async () => forged,
    readObserverHistory: async () => [],
    assertCurrent: async () => {},
  });
  await assert.rejects(
    f.verifier(verificationInput(f)),
    /within 1 seconds|verifiable Welcome reply/,
  );
  assert.deepEqual(f.unsubscribed.sort(), ["messages", "observer"]);
});

test("a reply without an acknowledged publication is rejected before subscriptions", async () => {
  const f = verifierFixture();
  await assert.rejects(
    f.verifier({
      ...verificationInput(f),
      acknowledgement: {
        ...verificationInput(f).acknowledgement,
        published: false,
      },
    }),
    /published|acknowledgment/,
  );
  assert.equal(f.unsubscribed.length, 0);
});
