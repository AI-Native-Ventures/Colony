import assert from "node:assert/strict";
import test from "node:test";

import { sortEvents } from "../../../shared/api/relayClientShared.ts";
import { reconcileChannelWindowMessages } from "./channelWindowReconciliation.ts";
import {
  compareRelayOrder,
  emptyChannelWindowStore,
  replaceNewestChannelWindow,
} from "./channelWindowStore.ts";
import { sortMessages } from "./messageQueryKeys.ts";

// The relay's canonical order is (created_at DESC, id ASC): see
// crates/buzz-db/src/event.rs and get_channel_window in
// crates/buzz-db/src/thread.rs. Read chronologically that is
// (created_at ASC, id DESC), so within one second the SMALLER id is the NEWER
// event and must sort last in an ascending timeline.
//
// Every client path that orders events has to agree on that, because they feed
// one array. They did not: sortMessages tiebroke ascending while
// compareRelayOrder tiebroke to match the relay, and a same-second pair could
// therefore swap position between a cache read and a window projection. The
// tail buffer in useBufferedTimelineMessages slices by position, so that swap
// emitted one id twice and rendered a duplicate row.

function event(id, createdAt) {
  return {
    id: id.padEnd(64, "0"),
    pubkey: "a".repeat(64),
    created_at: createdAt,
    kind: 9,
    tags: [["h", "channel"]],
    content: id,
    sig: "b".repeat(128),
  };
}

const SMALLER_ID = event("aaa", 100);
const LARGER_ID = event("bbb", 100);

test("the cache sort puts the smaller same-second id last", () => {
  assert.deepEqual(
    sortMessages([SMALLER_ID, LARGER_ID]).map((e) => e.content),
    ["bbb", "aaa"],
  );
  assert.deepEqual(
    sortMessages([LARGER_ID, SMALLER_ID]).map((e) => e.content),
    ["bbb", "aaa"],
    "input order must not change the result",
  );
});

test("the history REQ sort agrees with the cache sort", () => {
  assert.deepEqual(
    sortEvents([SMALLER_ID, LARGER_ID]).map((e) => e.content),
    sortMessages([SMALLER_ID, LARGER_ID]).map((e) => e.content),
  );
});

test("compareRelayOrder reversed agrees with the cache sort", () => {
  const newestFirst = [SMALLER_ID, LARGER_ID].sort(compareRelayOrder);
  assert.deepEqual(
    [...newestFirst].reverse().map((e) => e.content),
    sortMessages([SMALLER_ID, LARGER_ID]).map((e) => e.content),
  );
});

test("the window projection agrees with the cache sort", () => {
  // The relay pages newest first, so within second 100 the page is the smaller
  // id first.
  const store = replaceNewestChannelWindow(emptyChannelWindowStore(), {
    startCursor: null,
    rows: [SMALLER_ID, LARGER_ID].map((e) => ({ event: e, thread: null })),
    aux: [],
    nextCursor: null,
    hasMore: false,
  });
  assert.deepEqual(
    reconcileChannelWindowMessages(store, [SMALLER_ID, LARGER_ID]).map(
      (e) => e.content,
    ),
    sortMessages([SMALLER_ID, LARGER_ID]).map((e) => e.content),
  );
});
