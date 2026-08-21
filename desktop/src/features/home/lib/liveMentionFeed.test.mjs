import assert from "node:assert/strict";
import test from "node:test";

import { mergeLiveMentionsIntoHomeFeed } from "./liveMentionFeed.ts";

const CHANNEL_ID = "a27e1ee9-76a6-5bdf-a5d5-1d85610dad11";

function feed(mentions = []) {
  return {
    feed: {
      mentions,
      needsAction: [],
      activity: [],
      agentActivity: [],
    },
    meta: { since: 1, total: mentions.length, generatedAt: 1 },
  };
}

function event(id, createdAt, overrides = {}) {
  return {
    id,
    kind: 45001,
    pubkey: "author",
    content: `forum mention ${id}`,
    created_at: createdAt,
    tags: [
      ["h", CHANNEL_ID],
      ["p", "viewer"],
    ],
    sig: "sig",
    ...overrides,
  };
}

const channels = [
  { id: CHANNEL_ID, name: "watercooler", channelType: "forum" },
];

test("repairs a stale feed response with every pending live mention", () => {
  const first = event("first", 3);
  const second = event("second", 4);
  const stale = feed();

  const repaired = mergeLiveMentionsIntoHomeFeed(
    stale,
    [first, second],
    channels,
  );

  assert.deepEqual(
    repaired.feed.mentions.map((item) => item.id),
    ["second", "first"],
  );
  assert.equal(repaired.feed.mentions[0].channelName, "watercooler");
  assert.equal(repaired.feed.mentions[0].channelType, "forum");
  assert.equal(repaired.meta.total, 2);
});

test("does not double-count a live mention after the durable feed catches up", () => {
  const liveEvent = event("same", 5);
  const caughtUp = feed([
    {
      id: liveEvent.id,
      kind: liveEvent.kind,
      pubkey: liveEvent.pubkey,
      content: liveEvent.content,
      createdAt: liveEvent.created_at,
      channelId: CHANNEL_ID,
      channelName: "watercooler",
      channelType: "forum",
      tags: liveEvent.tags,
      category: "mention",
    },
  ]);

  const repaired = mergeLiveMentionsIntoHomeFeed(
    caughtUp,
    [liveEvent],
    channels,
  );

  assert.equal(repaired.feed.mentions.length, 1);
  assert.equal(repaired.meta.total, 1);
});

test("does not project stream mentions into the durable forum feed", () => {
  const current = feed();
  const streamMention = event("stream", 6, { kind: 40002 });

  const repaired = mergeLiveMentionsIntoHomeFeed(
    current,
    [streamMention],
    channels,
  );

  assert.equal(repaired, current);
});

test("repairs forum reply mentions without projecting stream thread replies", () => {
  const current = feed();
  const forumReply = event("forum-reply", 7, { kind: 45003 });
  const streamReply = event("stream-reply", 8, {
    kind: 40002,
    tags: [
      ["h", CHANNEL_ID],
      ["p", "viewer"],
      ["e", "stream-root", "", "root"],
    ],
  });

  const repaired = mergeLiveMentionsIntoHomeFeed(
    current,
    [forumReply, streamReply],
    channels,
  );

  assert.deepEqual(
    repaired.feed.mentions.map((item) => item.id),
    ["forum-reply"],
  );
  assert.equal(repaired.meta.total, 1);
});
