import assert from "node:assert/strict";
import test from "node:test";

import { inboxBadgeCount } from "./inboxBadge.ts";

/**
 * The Inbox badge sums three surfaces that overlap. A due reminder is both a
 * reminder and an action; a needs-action feed row is both an unread feed row
 * and a Block waiting for an answer. Counting the sources and adding the
 * numbers made one thing read as two.
 */

test("inbox_badge_counts_each_item_once", () => {
  const count = inboxBadgeCount({
    // One due reminder, and one unread feed row that is also a Block.
    feedItemIds: ["feed-block-1"],
    dueReminderEventIds: ["reminder-event-1"],
    actionItems: [
      { id: "reminder:reminder-d-tag-1", sourceId: "reminder-event-1" },
      { id: "block:feed-block-1", sourceId: "feed-block-1" },
    ],
  });

  // Two things are waiting, not four.
  assert.equal(count, 2);
});

test("an action with no counterpart in another source still counts", () => {
  assert.equal(
    inboxBadgeCount({
      feedItemIds: [],
      dueReminderEventIds: [],
      actionItems: [
        { id: "ask:ask-1", sourceId: null },
        { id: "workflow:wf-1:run-1", sourceId: null },
      ],
    }),
    2,
  );
});

test("a Block whose feed row is already read is counted once, not dropped", () => {
  assert.equal(
    inboxBadgeCount({
      feedItemIds: [],
      dueReminderEventIds: [],
      actionItems: [{ id: "block:feed-read-1", sourceId: "feed-read-1" }],
    }),
    1,
  );
});

test("repeats inside one source collapse", () => {
  assert.equal(
    inboxBadgeCount({
      feedItemIds: ["feed-1", "feed-1"],
      dueReminderEventIds: ["reminder-1", "reminder-1"],
      actionItems: [
        { id: "block:feed-1", sourceId: "feed-1" },
        { id: "block:feed-1", sourceId: "feed-1" },
      ],
    }),
    2,
  );
});

test("nothing waiting is zero", () => {
  assert.equal(
    inboxBadgeCount({
      feedItemIds: [],
      dueReminderEventIds: [],
      actionItems: [],
    }),
    0,
  );
});
