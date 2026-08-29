import assert from "node:assert/strict";
import test from "node:test";

import {
  PING_CANDIDATE_LIMIT,
  resolvePingRootId,
  selectAllRootIds,
  selectPingCandidates,
  selectRootIdsNeedingLookup,
  selectUnansweredPings,
} from "./threadPings.ts";

const OWNER = "a".repeat(64);
const PINGER = "b".repeat(64);
const RELAY_SELF = "c".repeat(64);

function candidate(overrides = {}) {
  return {
    id: "d".repeat(64),
    pubkey: PINGER,
    content: "hey @owner can you take a look",
    createdAt: 1_000,
    channelId: "channel-1",
    channelName: "general",
    tags: [],
    ...overrides,
  };
}

function relayEvent(overrides = {}) {
  return {
    id: "e".repeat(64),
    pubkey: PINGER,
    created_at: 1_000,
    kind: 9,
    tags: [],
    content: "",
    sig: "sig".repeat(20),
    ...overrides,
  };
}

const rootTag = (rootId) => ["e", rootId, "", "root"];
const replyTag = (parentId) => ["e", parentId, "", "reply"];
// getThreadReference only resolves a thread when a `reply`-marked tag is
// present (see threading.ts) -- a lone `root` tag is not enough. Real
// replies in this app always carry both; this fixture mirrors that.
const threadTags = (rootId) => [rootTag(rootId), replyTag(rootId)];

test("resolvePingRootId reads the explicit root tag first", () => {
  const rootId = "1".repeat(64);
  const parentId = "2".repeat(64);
  const event = candidate({
    tags: [rootTag(rootId), replyTag(parentId)],
  });
  assert.equal(resolvePingRootId(event), rootId);
});

test("resolvePingRootId falls back to the reply tag when no root tag is present", () => {
  const parentId = "2".repeat(64);
  const event = candidate({ tags: [replyTag(parentId)] });
  assert.equal(resolvePingRootId(event), parentId);
});

test("resolvePingRootId falls back to the event's own id with no thread tags: it IS the root", () => {
  const event = candidate({ id: "3".repeat(64), tags: [] });
  assert.equal(resolvePingRootId(event), "3".repeat(64));
});

test("selectPingCandidates drops candidates with no channel", () => {
  const withChannel = candidate({ id: "1".repeat(64), channelId: "c1" });
  const withoutChannel = candidate({ id: "2".repeat(64), channelId: null });
  const result = selectPingCandidates([withChannel, withoutChannel]);
  assert.deepEqual(
    result.map((item) => item.id),
    [withChannel.id],
  );
});

test("selectPingCandidates caps at the newest PING_CANDIDATE_LIMIT, oldest dropped first", () => {
  const total = PING_CANDIDATE_LIMIT + 5;
  const mentions = Array.from({ length: total }, (_, index) =>
    candidate({
      id: index.toString(16).padStart(64, "0"),
      createdAt: index, // ascending: highest index is newest
    }),
  );
  const result = selectPingCandidates(mentions);
  assert.equal(result.length, PING_CANDIDATE_LIMIT);
  const newestIds = mentions
    .slice(5) // the 5 oldest (lowest createdAt) should have been dropped
    .map((item) => item.id)
    .sort();
  assert.deepEqual(result.map((item) => item.id).sort(), newestIds);
});

test("selectRootIdsNeedingLookup only lists roots for candidates that are replies", () => {
  const rootId = "1".repeat(64);
  const selfRooted = candidate({ id: "2".repeat(64), tags: [] });
  const reply = candidate({ id: "3".repeat(64), tags: threadTags(rootId) });
  assert.deepEqual(selectRootIdsNeedingLookup([selfRooted, reply]), [rootId]);
});

test("selectAllRootIds includes self-rooted candidates' own ids", () => {
  const rootId = "1".repeat(64);
  const selfRooted = candidate({ id: "2".repeat(64), tags: [] });
  const reply = candidate({ id: "3".repeat(64), tags: threadTags(rootId) });
  assert.deepEqual(
    selectAllRootIds([selfRooted, reply]).sort(),
    [rootId, selfRooted.id].sort(),
  );
});

// --- Qualification: "sits in a thread the owner participates in" ---
// This is a positive requirement (spec: surface only when ALL hold), not a
// suppression -- a candidate that fails it is not a ping at all, regardless
// of replies or reactions.

test("qualifies and surfaces: the owner authored the thread root, no reply or reaction yet", () => {
  const rootId = "1".repeat(64);
  const pingId = "2".repeat(64);
  const ping = candidate({ id: pingId, tags: threadTags(rootId) });
  const rootEvent = relayEvent({ id: rootId, pubkey: OWNER });

  const pings = selectUnansweredPings([ping], {
    ownerPubkey: OWNER,
    relaySelfPubkey: RELAY_SELF,
    rootEvents: [rootEvent],
    replyEvents: [],
    reactionEvents: [],
  });

  assert.equal(pings.length, 1);
  assert.equal(pings[0].id, pingId);
  assert.equal(pings[0].threadId, rootId);
});

test("qualifies and surfaces: the owner posted in the thread before the ping, and hasn't since", () => {
  const rootId = "1".repeat(64);
  const ping = candidate({
    id: "2".repeat(64),
    tags: threadTags(rootId),
    createdAt: 1_000,
  });
  const rootEvent = relayEvent({ id: rootId, pubkey: PINGER });
  const olderOwnerPost = relayEvent({
    id: "3".repeat(64),
    pubkey: OWNER,
    created_at: 500, // before the ping -- still counts as "has posted here"
    tags: threadTags(rootId),
  });

  const pings = selectUnansweredPings([ping], {
    ownerPubkey: OWNER,
    relaySelfPubkey: RELAY_SELF,
    rootEvents: [rootEvent],
    replyEvents: [olderOwnerPost],
    reactionEvents: [],
  });

  assert.equal(pings.length, 1);
});

test("NOT qualified: a reply in a thread the owner has never posted in or started", () => {
  const rootId = "1".repeat(64);
  const ping = candidate({ id: "2".repeat(64), tags: threadTags(rootId) });
  const rootEvent = relayEvent({ id: rootId, pubkey: PINGER });

  const pings = selectUnansweredPings([ping], {
    ownerPubkey: OWNER,
    relaySelfPubkey: RELAY_SELF,
    rootEvents: [rootEvent],
    replyEvents: [],
    reactionEvents: [],
  });

  assert.equal(pings.length, 0);
});

test("NOT qualified: a self-rooted mention by someone else -- an ordinary mention, not a ping", () => {
  const ping = candidate({ id: "2".repeat(64), pubkey: PINGER, tags: [] });

  const pings = selectUnansweredPings([ping], {
    ownerPubkey: OWNER,
    relaySelfPubkey: RELAY_SELF,
    rootEvents: [],
    replyEvents: [],
    reactionEvents: [],
  });

  assert.equal(pings.length, 0);
});

test("qualifies (degenerate) and surfaces: a self-rooted message the owner themselves authored", () => {
  const ping = candidate({ id: "2".repeat(64), pubkey: OWNER, tags: [] });

  const pings = selectUnansweredPings([ping], {
    ownerPubkey: OWNER,
    relaySelfPubkey: RELAY_SELF,
    rootEvents: [],
    replyEvents: [],
    reactionEvents: [],
  });

  assert.equal(pings.length, 1);
});

// --- Suppression: only reached once qualified ---

test("suppressed: the owner replied in the thread after the ping", () => {
  const rootId = "1".repeat(64);
  const ping = candidate({
    id: "2".repeat(64),
    tags: threadTags(rootId),
    createdAt: 1_000,
  });
  const rootEvent = relayEvent({ id: rootId, pubkey: OWNER }); // qualifies
  const ownerReply = relayEvent({
    id: "3".repeat(64),
    pubkey: OWNER,
    created_at: 1_500,
    tags: threadTags(rootId),
  });

  const pings = selectUnansweredPings([ping], {
    ownerPubkey: OWNER,
    relaySelfPubkey: RELAY_SELF,
    rootEvents: [rootEvent],
    replyEvents: [ownerReply],
    reactionEvents: [],
  });

  assert.equal(pings.length, 0);
});

test("suppressed: any owner reaction on the ping, not only the dismiss emoji", () => {
  const rootId = "1".repeat(64);
  const pingId = "2".repeat(64);
  const ping = candidate({ id: pingId, tags: threadTags(rootId) });
  const rootEvent = relayEvent({ id: rootId, pubkey: OWNER }); // qualifies
  const ownerReaction = relayEvent({
    id: "3".repeat(64),
    kind: 7,
    pubkey: OWNER,
    content: "👍",
    tags: [["e", pingId]],
  });

  const pings = selectUnansweredPings([ping], {
    ownerPubkey: OWNER,
    relaySelfPubkey: RELAY_SELF,
    rootEvents: [rootEvent],
    replyEvents: [],
    reactionEvents: [ownerReaction],
  });

  assert.equal(pings.length, 0);
});

test("NOT suppressed: a reaction from someone other than the owner", () => {
  const rootId = "1".repeat(64);
  const pingId = "2".repeat(64);
  const ping = candidate({ id: pingId, tags: threadTags(rootId) });
  const rootEvent = relayEvent({ id: rootId, pubkey: OWNER }); // qualifies
  const someoneElsesReaction = relayEvent({
    id: "3".repeat(64),
    kind: 7,
    pubkey: "f".repeat(64),
    content: "👍",
    tags: [["e", pingId]],
  });

  const pings = selectUnansweredPings([ping], {
    ownerPubkey: OWNER,
    relaySelfPubkey: RELAY_SELF,
    rootEvents: [rootEvent],
    replyEvents: [],
    reactionEvents: [someoneElsesReaction],
  });

  assert.equal(pings.length, 1);
});

test("fail-closed: a reply candidate whose root event the batched lookup missed is dropped, not guessed at", () => {
  const rootId = "1".repeat(64);
  const ping = candidate({ id: "2".repeat(64), tags: threadTags(rootId) });

  const pings = selectUnansweredPings([ping], {
    ownerPubkey: OWNER,
    relaySelfPubkey: RELAY_SELF,
    rootEvents: [], // root fetch came back empty for this id
    replyEvents: [],
    reactionEvents: [],
  });

  assert.equal(pings.length, 0);
});

test("a reaction targeting a different event does not suppress this ping", () => {
  const rootId = "1".repeat(64);
  const pingId = "2".repeat(64);
  const ping = candidate({ id: pingId, tags: threadTags(rootId) });
  const rootEvent = relayEvent({ id: rootId, pubkey: OWNER }); // qualifies
  const reactionOnSomethingElse = relayEvent({
    id: "3".repeat(64),
    kind: 7,
    pubkey: OWNER,
    content: "👍",
    tags: [["e", "9".repeat(64)]],
  });

  const pings = selectUnansweredPings([ping], {
    ownerPubkey: OWNER,
    relaySelfPubkey: RELAY_SELF,
    rootEvents: [rootEvent],
    replyEvents: [],
    reactionEvents: [reactionOnSomethingElse],
  });

  assert.equal(pings.length, 1);
});

test("a reply to a different thread root neither qualifies nor suppresses this ping", () => {
  const rootId = "1".repeat(64);
  const otherRootId = "9".repeat(64);
  const ping = candidate({
    id: "2".repeat(64),
    tags: threadTags(rootId),
    createdAt: 1_000,
  });
  const rootEvent = relayEvent({ id: rootId, pubkey: OWNER }); // qualifies
  const replyInOtherThread = relayEvent({
    id: "3".repeat(64),
    pubkey: OWNER,
    created_at: 2_000,
    tags: threadTags(otherRootId),
  });

  const pings = selectUnansweredPings([ping], {
    ownerPubkey: OWNER,
    relaySelfPubkey: RELAY_SELF,
    rootEvents: [rootEvent],
    replyEvents: [replyInOtherThread],
    reactionEvents: [],
  });

  assert.equal(pings.length, 1);
});
