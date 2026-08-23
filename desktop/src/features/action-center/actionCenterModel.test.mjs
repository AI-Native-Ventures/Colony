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

const CLOSED_ASK_HEX = "a".repeat(64);

function closedAsk(id = CLOSED_ASK_HEX) {
  return {
    ...ask(),
    id,
    headline: "Pick the refund policy",
  };
}

function resolution(eventId, askId, createdAt, content, pubkey = PUBKEY) {
  return {
    eventId,
    askId,
    resolverPubkey: pubkey,
    createdAt,
    defaultExecuted: content.default_executed === true,
    appliedOption:
      typeof content.answer?.option === "string" ? content.answer.option : null,
    decision:
      typeof content.answer?.decision === "string"
        ? content.answer.decision
        : null,
    rationale:
      typeof content.answer?.rationale === "string"
        ? content.answer.rationale
        : null,
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

test("keeps stream reminders while deduplicating local reminders and job records", () => {
  const items = buildActionCenterItems({
    asks: [],
    feed: {
      mentions: [
        { ...message("stream-reminder", 700), kind: 40007 },
        { ...message("reminder-1-event", 400, "mention") },
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
    ["message:stream-reminder", "reminder:reminder-1"],
  );
  assert.equal(items[0]?.source.kind, "message");
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

test("treats recoverable task runs as actionable rather than in progress", () => {
  const [item] = buildActionCenterItems({
    asks: [],
    reminders: [],
    tasks: [
      {
        kind: "task",
        task: {
          id: "task-recoverable",
          title: "Resume the interrupted task",
          status: "ready",
          createdAt: 100,
          updatedAt: 120,
          sourceChannelId: "channel-1",
          sourceEventId: "thread-1",
        },
        run: {
          eventId: "head-1",
          jobId: "job-1",
          employeePubkey: PUBKEY,
          originatorPubkey: PUBKEY,
          filedByPubkey: PUBKEY,
          taskId: "task-recoverable",
          channelId: "channel-1",
          threadId: "thread-1",
          runStatus: "recoverable",
          attempts: 1,
          leaseHolderPubkey: null,
          leaseExpiresAt: null,
          instruction: "Resume",
          result: null,
          failure: null,
          checkpoint: null,
          artifacts: [],
          outcomeEventId: null,
          createdAt: 200,
        },
        channelId: "channel-1",
        threadId: "thread-1",
      },
    ],
  });

  assert.equal(item?.state, "needs-action");
  assert.equal(filterActionCenterItems([item], "needs-action").length, 1);
});

test("applies optional state filters without changing the default queue", () => {
  const items = buildActionCenterItems({
    asks: [ask("ask-open")],
    feed: {
      mentions: [message("message-active", 300, "activity")],
      needsAction: [],
      activity: [],
      agentActivity: [],
    },
    reminders: [],
  });

  assert.deepEqual(
    filterActionCenterItems(items, "all", "open").map((item) => item.id),
    ["ask:ask-open"],
  );
  assert.deepEqual(
    filterActionCenterItems(items, "all", "active").map((item) => item.id),
    ["message:message-active"],
  );
  assert.equal(
    filterActionCenterItems(items, "needs-action", "completed").length,
    0,
  );
});

test("a resolved ask appears as a completed item whose summary accounts for the answer", () => {
  const items = buildActionCenterItems({
    asks: [],
    resolvedAsks: [
      {
        resolution: resolution("res-human", CLOSED_ASK_HEX, 400, {
          answer: { decision: "Refund in full" },
        }),
        ask: closedAsk(),
      },
    ],
    resolverLabelsByPubkey: new Map([[PUBKEY, "Basheer"]]),
    feed: { mentions: [], needsAction: [], activity: [], agentActivity: [] },
    reminders: [],
  });

  const [item] = items;
  assert.equal(item.id, `resolved-ask:${CLOSED_ASK_HEX}`);
  assert.equal(item.kind, "ask");
  assert.equal(item.state, "completed");
  assert.equal(
    item.summary.includes("Basheer"),
    true,
    "a human answer names who answered",
  );
  assert.equal(item.summary.includes("Refund in full"), true);
  assert.equal(countActionableItems(items), 0);
});

test("an executed default is visibly distinct and names the applied option", () => {
  const relayPubkey = "b".repeat(64);
  const items = buildActionCenterItems({
    asks: [],
    resolvedAsks: [
      {
        resolution: resolution(
          "res-default",
          CLOSED_ASK_HEX,
          400,
          {
            answer: { option: "Ship v2 to every customer" },
            default_executed: true,
          },
          relayPubkey,
        ),
        ask: closedAsk(),
      },
    ],
    resolverLabelsByPubkey: new Map(),
    feed: { mentions: [], needsAction: [], activity: [], agentActivity: [] },
    reminders: [],
  });

  const [item] = items;
  assert.equal(item.state, "completed");
  assert.equal(
    item.source.resolution?.defaultExecuted,
    true,
    "the row must know this was an executed default so it can be marked",
  );
  assert.equal(item.summary.includes("Nobody answered"), true);
  assert.equal(item.summary.includes("deadline"), true);
  assert.equal(item.summary.includes("Ship v2 to every customer"), true);
});

test("resolved asks show under the asks filter alongside open ones", () => {
  const items = buildActionCenterItems({
    asks: [ask("ask-open")],
    resolvedAsks: [
      {
        resolution: resolution("res-1", CLOSED_ASK_HEX, 400, {
          answer: { decision: "Done" },
        }),
        ask: closedAsk(),
      },
    ],
    feed: { mentions: [], needsAction: [], activity: [], agentActivity: [] },
    reminders: [],
  });

  const askFilter = filterActionCenterItems(items, "asks");
  assert.deepEqual(askFilter.map((item) => item.id).sort(), [
    "ask:ask-open",
    `resolved-ask:${CLOSED_ASK_HEX}`,
  ]);
  assert.equal(
    filterActionCenterItems(items, "asks", "completed").length,
    1,
    "the state filter reaches closed asks too",
  );
});
