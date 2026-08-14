import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActionCenterItems,
  countActionableItems,
  filterActionCenterItems,
} from "./actionCenterModel.ts";

const PUBKEY = "a".repeat(64);

function message(
  id,
  createdAt,
  category = "needs_action",
  channelId = "channel-1",
) {
  return {
    id,
    kind: 9,
    pubkey: PUBKEY,
    content: `Message ${id}`,
    createdAt,
    channelId,
    channelName: "general",
    tags: [["e", "root-1"]],
    category,
  };
}

function reminder(id, eventId = `${id}-event`) {
  return {
    id,
    eventId,
    createdAt: 250,
    notBefore: 350,
    content: {
      status: "pending",
      note: "Follow up",
      target: {
        eventId: "target-1",
        channelId: "channel-1",
        preview: "Target message",
        authorPubkey: PUBKEY,
      },
    },
  };
}

function ask(id = "ask-1") {
  return {
    id,
    askType: "decision",
    headline: "Approve the launch brief",
    costOfDelay: "Launch slips one day",
    filerPubkey: PUBKEY,
    createdAt: 100,
    rawContent: "{}",
  };
}

test("projects actionable sources into stable, sorted items", () => {
  const items = buildActionCenterItems({
    asks: [ask()],
    feed: {
      mentions: [message("message-1", 200, "mention")],
      needsAction: [message("approval-1", 300)],
      activity: [],
      agentActivity: [],
    },
    reminders: [reminder("reminder-1")],
  });

  assert.deepEqual(
    items.map((item) => item.id),
    [
      "reminder:reminder-1",
      "message:approval-1",
      "message:message-1",
      "ask:ask-1",
    ],
  );
  assert.equal(filterActionCenterItems(items, "asks").length, 1);
  assert.equal(filterActionCenterItems(items, "needs-action").length, 4);
  assert.equal(countActionableItems(items), 4);
  assert.equal(items[1]?.source.kind, "message");
  assert.deepEqual(
    items[1]?.source.kind === "message" ? items[1].source.threadRootId : null,
    "root-1",
  );
});

test("deduplicates structured reminder and ignored workflow/job feed events", () => {
  const items = buildActionCenterItems({
    asks: [],
    feed: {
      mentions: [
        message("reminder-1-event", 400, "mention"),
        { ...message("job-1", 500), kind: 43003 },
        { ...message("approval-1", 600), kind: 46010 },
      ],
      needsAction: [],
      activity: [],
      agentActivity: [],
    },
    reminders: [reminder("reminder-1", "reminder-1-event")],
  });

  assert.deepEqual(
    items.map((item) => item.id),
    ["reminder:reminder-1"],
  );
});

test("uses local done state for message actions without hiding all activity", () => {
  const items = buildActionCenterItems({
    asks: [],
    feed: {
      mentions: [message("message-1", 100, "mention")],
      needsAction: [],
      activity: [],
      agentActivity: [],
    },
    reminders: [],
    doneIds: new Set(["message-1"]),
  });

  assert.equal(items[0]?.state, "completed");
  assert.deepEqual(items[0]?.capabilities, ["open-source", "undo-done"]);
  assert.equal(filterActionCenterItems(items, "needs-action").length, 0);
  assert.equal(filterActionCenterItems(items, "all").length, 1);
});

test("projects durable tasks and real workflow recovery records", () => {
  const items = buildActionCenterItems({
    asks: [],
    reminders: [],
    tasks: [
      {
        kind: "task",
        task: {
          id: "task-1",
          title: "Review launch brief",
          status: "ready",
          createdAt: 100,
          updatedAt: 120,
          sourceChannelId: "channel-1",
          sourceEventId: "thread-1",
        },
        run: null,
        channelId: "channel-1",
        threadId: "thread-1",
      },
    ],
    workflows: [
      {
        kind: "workflow",
        workflow: { id: "workflow-1", name: "Release checks" },
        run: {
          id: "run-1",
          status: "failed",
          createdAt: 200,
          completedAt: 220,
          executionTrace: [],
        },
        approval: null,
      },
    ],
  });

  assert.deepEqual(
    items.map((item) => item.id),
    ["workflow:workflow-1:run-1", "task:task-1"],
  );
  assert.equal(filterActionCenterItems(items, "tasks").length, 1);
  assert.equal(items[0]?.state, "failed");
  assert.equal(items[0]?.capabilities.includes("run-again"), true);
  assert.equal(items[1]?.capabilities.includes("open-source"), true);
});
