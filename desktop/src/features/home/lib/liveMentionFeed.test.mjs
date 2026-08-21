import assert from "node:assert/strict";
import test from "node:test";

import {
  appendPendingLiveMention,
  mergePendingLiveMentionsIntoHomeFeed,
  reconcileHomeFeedRead,
  reconcilePendingLiveMentions,
} from "./liveMentionFeed.ts";

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

function repairLiveEvents(current, events) {
  const pending = events.reduce(
    (items, liveEvent) => appendPendingLiveMention(items, liveEvent, channels),
    [],
  );
  return mergePendingLiveMentionsIntoHomeFeed(current, pending);
}

test("repairs a stale feed response with every pending live mention", () => {
  const first = event("first", 3);
  const second = event("second", 4);
  const stale = feed();

  const repaired = repairLiveEvents(stale, [first, second]);

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

  const repaired = repairLiveEvents(caughtUp, [liveEvent]);

  assert.equal(repaired.feed.mentions.length, 1);
  assert.equal(repaired.meta.total, 1);
});

test("does not project stream mentions into the durable forum feed", () => {
  const current = feed();
  const streamMention = event("stream", 6, { kind: 40002 });

  const repaired = repairLiveEvents(current, [streamMention]);

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

  const repaired = repairLiveEvents(current, [forumReply, streamReply]);

  assert.deepEqual(
    repaired.feed.mentions.map((item) => item.id),
    ["forum-reply"],
  );
  assert.equal(repaired.meta.total, 1);
});

test("preserves a pending mention through repeated stale reads and releases it after catch-up", () => {
  const liveEvent = event("pending", 9);
  const pending = appendPendingLiveMention([], liveEvent, channels);

  const firstStale = reconcilePendingLiveMentions(feed(), pending);
  const secondStale = reconcilePendingLiveMentions(feed(), firstStale.pending);

  assert.deepEqual(
    secondStale.response.feed.mentions.map((item) => item.id),
    ["pending"],
  );
  assert.equal(secondStale.pending.length, 1);

  const caughtUp = reconcilePendingLiveMentions(
    feed(secondStale.response.feed.mentions),
    secondStale.pending,
  );

  assert.equal(caughtUp.response.feed.mentions.length, 1);
  assert.equal(caughtUp.pending.length, 0);

  const afterRelease = reconcilePendingLiveMentions(feed(), caughtUp.pending);
  assert.equal(afterRelease.response.feed.mentions.length, 0);
});

test("restores a request-start mention when an overlapping stale read finishes after catch-up", () => {
  const pendingAtStart = appendPendingLiveMention(
    [],
    event("overlap", 10),
    channels,
  );
  const caughtUp = reconcilePendingLiveMentions(
    feed(pendingAtStart),
    pendingAtStart,
    pendingAtStart,
  );
  assert.equal(caughtUp.pending.length, 0);

  const staleCompletedLast = reconcilePendingLiveMentions(
    feed(),
    pendingAtStart,
    caughtUp.pending,
  );

  assert.deepEqual(
    staleCompletedLast.response.feed.mentions.map((item) => item.id),
    ["overlap"],
  );
  assert.deepEqual(
    staleCompletedLast.pending.map((item) => item.id),
    ["overlap"],
  );
});

test("does not let a canceled feed read retire pending mentions", async () => {
  let pending = appendPendingLiveMention(
    [],
    event("cancelled-catch-up", 11),
    channels,
  );
  let resolveDurable;
  let writes = 0;
  const controller = new AbortController();
  const read = reconcileHomeFeedRead({
    readDurable: () =>
      new Promise((resolve) => {
        resolveDurable = resolve;
      }),
    readPending: () => pending,
    signal: controller.signal,
    writePending: (nextPending) => {
      writes += 1;
      pending = nextPending;
    },
  });

  controller.abort();
  resolveDurable(feed(pending));
  await read;

  assert.equal(writes, 0);
  assert.deepEqual(
    pending.map((item) => item.id),
    ["cancelled-catch-up"],
  );
});

test("deduplicates pending mentions and keeps only the newest 50", () => {
  let pending = [];
  for (let createdAt = 0; createdAt < 50; createdAt += 1) {
    pending = appendPendingLiveMention(
      pending,
      event(`event-${createdAt}`, createdAt),
      channels,
    );
  }

  pending = appendPendingLiveMention(
    pending,
    event("event-25", 100, { content: "updated duplicate" }),
    channels,
  );
  pending = appendPendingLiveMention(pending, event("event-50", 50), channels);

  assert.equal(pending.length, 50);
  assert.equal(new Set(pending.map((item) => item.id)).size, 50);
  assert.equal(pending[0].id, "event-25");
  assert.equal(pending[0].content, "updated duplicate");
  assert.equal(
    pending.some((item) => item.id === "event-0"),
    false,
  );
  assert.deepEqual(
    pending.map((item) => item.createdAt),
    [...pending.map((item) => item.createdAt)].sort(
      (left, right) => right - left,
    ),
  );
});

test("reserves a feed slot for an unresolved mention older than 50 durable items", () => {
  const pending = appendPendingLiveMention(
    [],
    event("pending-old", 1),
    channels,
  );
  const durableMentions = Array.from(
    { length: 50 },
    (_, index) =>
      appendPendingLiveMention(
        [],
        event(`durable-${index}`, 100 + index),
        channels,
      )[0],
  );

  const reconciled = reconcilePendingLiveMentions(
    feed(durableMentions),
    pending,
  );

  assert.equal(reconciled.response.feed.mentions.length, 50);
  assert.equal(
    reconciled.response.feed.mentions.some((item) => item.id === "pending-old"),
    true,
  );
  assert.equal(
    reconciled.response.feed.mentions.some((item) => item.id === "durable-0"),
    false,
  );
  assert.deepEqual(
    reconciled.pending.map((item) => item.id),
    ["pending-old"],
  );
});
