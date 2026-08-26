import assert from "node:assert/strict";
import test from "node:test";

import {
  isLiveMentionCandidate,
  trackSeenEvent,
} from "./useLiveChannelUpdates.ts";
import {
  KIND_FORUM_POST,
  KIND_REACTION,
  KIND_STREAM_MESSAGE,
} from "@/shared/constants/kinds";

const SELF = "a".repeat(64);
const OTHER = "b".repeat(64);

function mention(overrides = {}) {
  return {
    id: "event-1",
    kind: KIND_FORUM_POST,
    pubkey: OTHER,
    content: "Forum ping",
    created_at: 1,
    tags: [
      ["h", "channel-1"],
      ["p", SELF],
    ],
    ...overrides,
  };
}

// The candidate check has to mirror `buildChannelMentionFilter`, because the
// channel subscription it now runs on carries every event in the channel, not
// a relay-filtered subset. Anything looser puts events in the Inbox that the
// mention subscription would never have delivered.

test("a forum mention from someone else is a candidate", () => {
  assert.equal(isLiveMentionCandidate(mention(), SELF), true);
});

test("a stream message mention is a candidate too", () => {
  assert.equal(
    isLiveMentionCandidate(mention({ kind: KIND_STREAM_MESSAGE }), SELF),
    true,
  );
});

test("a kind outside the mention filter is not a candidate", () => {
  assert.equal(
    isLiveMentionCandidate(mention({ kind: KIND_REACTION }), SELF),
    false,
  );
});

test("a message with no p tag for us is not a candidate", () => {
  assert.equal(
    isLiveMentionCandidate(mention({ tags: [["h", "channel-1"]] }), SELF),
    false,
  );
});

test("a message p-tagging someone else is not a candidate", () => {
  assert.equal(
    isLiveMentionCandidate(
      mention({
        tags: [
          ["h", "channel-1"],
          ["p", OTHER],
        ],
      }),
      SELF,
    ),
    false,
  );
});

test("our own mention of ourselves is not a candidate", () => {
  assert.equal(isLiveMentionCandidate(mention({ pubkey: SELF }), SELF), false);
});

test("no identity yet means no candidate", () => {
  assert.equal(isLiveMentionCandidate(mention(), ""), false);
});

// Exactly-once across the two delivery paths. Both take the same
// `seenMentionEventIds` guard, so whichever subscription arrives first
// dispatches and the other is a no-op. `dispatch` below is the shape of both
// call sites: candidate check, then the shared guard.

function dispatch(seen, event, pubkey, sink) {
  if (isLiveMentionCandidate(event, pubkey) && trackSeenEvent(seen, event.id)) {
    sink.push(event.id);
  }
}

test("the channel subscription alone dispatches once", () => {
  const seen = new Set();
  const sink = [];
  dispatch(seen, mention(), SELF, sink);
  assert.deepEqual(sink, ["event-1"]);
});

test("both subscriptions delivering the same event dispatch once", () => {
  const seen = new Set();
  const sink = [];
  dispatch(seen, mention(), SELF, sink);
  dispatch(seen, mention(), SELF, sink);
  assert.deepEqual(sink, ["event-1"]);
});

// A reconnect replays each live filter with a five-second overlap, so the same
// event can arrive several times on one subscription.
test("a replayed event does not dispatch again", () => {
  const seen = new Set();
  const sink = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    dispatch(seen, mention(), SELF, sink);
  }
  assert.deepEqual(sink, ["event-1"]);
});

test("distinct events each dispatch once", () => {
  const seen = new Set();
  const sink = [];
  dispatch(seen, mention({ id: "event-1" }), SELF, sink);
  dispatch(seen, mention({ id: "event-2" }), SELF, sink);
  dispatch(seen, mention({ id: "event-1" }), SELF, sink);
  assert.deepEqual(sink, ["event-1", "event-2"]);
});
