import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActionCenterItems,
  countActionableItems,
  filterActionCenterItems,
} from "./actionCenterModel.ts";

const PUBKEY = "a".repeat(64);

/** A generic `needsAction` feed row, not a Block instance. */
function feedItem(
  id,
  createdAt,
  category = "needs_action",
  channelId = "channel-1",
) {
  return {
    id,
    kind: 9,
    pubkey: PUBKEY,
    content: `Feed item ${id}`,
    createdAt,
    channelId,
    channelName: "general",
    tags: [["e", "root-1"]],
    category,
  };
}

function reminder(id, eventId = `${id}-event`, overrides = {}) {
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
    ...overrides,
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
    reminders: [reminder("reminder-1")],
    now: 400,
  });

  assert.deepEqual(
    items.map((item) => item.id),
    ["reminder:reminder-1", "ask:ask-1"],
  );
  assert.equal(filterActionCenterItems(items, "asks").length, 1);
  assert.equal(filterActionCenterItems(items, "needs-action").length, 2);
  assert.equal(countActionableItems(items), 2);
});

test("only due reminders enter the queue — pending alone is not enough", () => {
  // Reuses `isDue` (the same logic backing the Home badge's
  // `countDueReminders`) rather than a second definition of "due": a pending
  // reminder whose `notBefore` has not arrived yet must not inflate the
  // queue, and a cancelled reminder never belongs here even once its
  // `notBefore` has passed.
  const now = 1_000;
  const due = reminder("due-1", "due-1-event", { notBefore: 900 });
  const dueAtBoundary = reminder("boundary-1", "boundary-1-event", {
    notBefore: now,
  });
  const notYetDue = reminder("future-1", "future-1-event", {
    notBefore: 1_100,
  });
  const cancelled = reminder("cancelled-1", "cancelled-1-event", {
    notBefore: 500,
    content: {
      status: "cancelled",
      note: "Follow up",
    },
  });

  const items = buildActionCenterItems({
    asks: [],
    reminders: [due, dueAtBoundary, notYetDue, cancelled],
    now,
  });

  assert.deepEqual(items.map((item) => item.id).sort(), [
    "reminder:boundary-1",
    "reminder:due-1",
  ]);
});

test("filters structured feed kinds and stream-duplicated reminders out of the needsAction feed", () => {
  const items = buildActionCenterItems({
    asks: [],
    feed: {
      needsAction: [
        { ...feedItem("stream-reminder", 700), kind: 40007 },
        feedItem("reminder-1-event", 400),
        { ...feedItem("job-1", 500), kind: 43003 },
        { ...feedItem("approval-1", 600), kind: 46010 },
      ],
    },
    reminders: [reminder("reminder-1", "reminder-1-event")],
    now: 400,
  });

  // None of the structured rows, nor the row already surfaced by the
  // dedicated reminders read, becomes a queue item — and none of them parse
  // as a Block instance, so nothing else is produced either.
  assert.deepEqual(
    items.map((item) => item.id),
    ["reminder:reminder-1"],
  );
});

test("applies optional state filters without changing the default queue", () => {
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
    reminders: [],
  });

  assert.deepEqual(
    filterActionCenterItems(items, "all", "open").map((item) => item.id),
    ["ask:ask-open"],
  );
  assert.deepEqual(
    filterActionCenterItems(items, "all", "completed").map((item) => item.id),
    [`resolved-ask:${CLOSED_ASK_HEX}`],
  );
  assert.equal(
    filterActionCenterItems(items, "needs-action", "completed").length,
    0,
  );
});

test("an owner-addressed pending workflow approval is a needs-action item", () => {
  const items = buildActionCenterItems({
    asks: [],
    reminders: [],
    workflows: [
      {
        kind: "workflow",
        workflow: { id: "workflow-1", name: "Release checks" },
        run: {
          id: "run-1",
          status: "waiting_approval",
          createdAt: 200,
          completedAt: null,
          executionTrace: [],
        },
        approval: {
          token: "token-1",
          stepId: "notify-legal",
          status: "pending",
          approverSpec: PUBKEY,
        },
      },
    ],
  });

  assert.deepEqual(
    items.map((item) => item.id),
    ["workflow:workflow-1:run-1"],
  );
  assert.equal(items[0]?.state, "needs-action");
  assert.deepEqual(items[0]?.capabilities, [
    "open-details",
    "open-source",
    "approve",
    "deny",
  ]);
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
