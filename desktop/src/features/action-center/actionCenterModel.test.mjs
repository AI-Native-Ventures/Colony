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

function ask(id = "ask-1", overrides = {}) {
  return {
    id,
    askType: "decision",
    headline: "Approve the launch brief",
    costOfDelay: "Launch slips one day",
    filerPubkey: PUBKEY,
    createdAt: 100,
    rawContent: "{}",
    channelId: null,
    threadId: null,
    audiencePubkey: null,
    priorAskId: null,
    originalFilerPubkey: null,
    taskIds: ["task-1"],
    category: null,
    defaultOption: null,
    defaultWindowSecs: null,
    initiativeId: "no-initiative",
    ...overrides,
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

  // The ask (no `default_option`) is tier 2 (blocked work); the reminder is
  // tier 3 (everything else) — tier 2 outranks tier 3 regardless of age.
  assert.deepEqual(
    items.map((item) => item.id),
    ["ask:ask-1", "reminder:reminder-1"],
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

test("ranks strictly by tier — deadline, then blocked work, then everything else, then settled rows", () => {
  const workflowSource = (id, createdAt) => ({
    kind: "workflow",
    workflow: { id, name: `Workflow ${id}` },
    run: {
      id: `run-${id}`,
      status: "waiting_approval",
      createdAt,
      completedAt: null,
      executionTrace: [],
    },
    approval: {
      token: `token-${id}`,
      stepId: "step",
      status: "pending",
      approverSpec: PUBKEY,
    },
  });

  const items = buildActionCenterItems({
    asks: [
      // Tier 2 (blocked work): no default_option. Filed last (createdAt 500)
      // but a blocked-work item still outranks every tier-3 item.
      ask("ask-blocked", { createdAt: 500, taskIds: ["task-1", "task-2"] }),
      // Tier 1 (deadline): has a default_option, so it ranks first no
      // matter how recently it was filed.
      ask("ask-deadline", {
        createdAt: 900,
        defaultOption: "Ship it",
        defaultWindowSecs: 60,
      }),
    ],
    resolvedAsks: [
      {
        resolution: resolution("res-1", CLOSED_ASK_HEX, 1_000, {
          answer: { decision: "Done" },
        }),
        ask: closedAsk(),
      },
    ],
    // Tier 3 items are ranked by "how long has this been waiting"
    // (`updatedAt`: a reminder's is its `notBefore`, a workflow's is its
    // run's `createdAt`, a ping's is its own `createdAt`) — the ping's 10
    // predates the workflow's 20 and the reminder's `notBefore` of 380, so
    // the ping is the oldest of the three.
    reminders: [reminder("reminder-1", "reminder-1-event", { notBefore: 380 })],
    workflows: [workflowSource("wf-1", 20)],
    pings: [
      {
        id: "ping-1",
        channelId: "channel-1",
        channelName: "general",
        threadId: "root-1",
        createdAt: 10,
        content: "hey @owner can you take a look",
      },
    ],
    now: 400,
  });

  assert.deepEqual(
    items.map((item) => item.id),
    [
      "ask:ask-deadline", // tier 1: deadline
      "ask:ask-blocked", // tier 2: blocked work
      "ping:ping-1", // tier 3: everything else, oldest
      "workflow:wf-1:run-wf-1", // tier 3: everything else, next oldest
      "reminder:reminder-1", // tier 3: everything else, newest
      `resolved-ask:${CLOSED_ASK_HEX}`, // settled sink, last regardless of tier
    ],
  );
});

test("a ping's title names the channel, summary is its content, dismiss/open-source are its only capabilities", () => {
  const items = buildActionCenterItems({
    asks: [],
    reminders: [],
    pings: [
      {
        id: "ping-1",
        channelId: "channel-1",
        channelName: "engineering",
        threadId: "root-1",
        createdAt: 500,
        content: "can you approve this before EOD?",
      },
    ],
  });

  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.kind, "ping");
  assert.equal(item.state, "needs-action");
  assert.equal(item.title, "asked in #engineering");
  assert.equal(item.summary, "can you approve this before EOD?");
  assert.deepEqual(item.capabilities, ["dismiss", "open-source"]);
  assert.deepEqual(item.source, {
    kind: "ping",
    ping: {
      id: "ping-1",
      channelId: "channel-1",
      channelName: "engineering",
      threadId: "root-1",
      createdAt: 500,
      content: "can you approve this before EOD?",
    },
  });
});

test("tier 2 ranks asks by blast radius descending, Block instances always last, ties broken by age", () => {
  const MANIFEST_ID = "b".repeat(64);
  const feedBlock = (id, createdAt) => ({
    id,
    kind: 9,
    pubkey: PUBKEY,
    content: "## Approve the spend\nDetails",
    createdAt,
    channelId: "channel-1",
    channelName: "general",
    tags: [
      ["e", MANIFEST_ID, "", "block"],
      [
        "block",
        "1",
        "approval",
        MANIFEST_ID,
        "11111111-1111-4111-8111-111111111111",
      ],
      ["block-data", '{"amount":500}'],
      ["block-attention", "1", "required"],
      ["p", "c".repeat(64)],
      ["block-processor", "1", PUBKEY],
    ],
    category: "needs_action",
  });

  const items = buildActionCenterItems({
    asks: [
      ask("ask-wide", { createdAt: 300, taskIds: ["t1", "t2", "t3"] }),
      ask("ask-narrow", { createdAt: 100, taskIds: ["t1"] }),
      ask("ask-narrow-newer", { createdAt: 200, taskIds: ["t1"] }),
    ],
    feed: {
      needsAction: [feedBlock("block-old", 50), feedBlock("block-new", 150)],
    },
    reminders: [],
  });

  assert.deepEqual(
    items.map((item) => item.id),
    [
      "ask:ask-wide", // blast radius 3
      "ask:ask-narrow", // blast radius 1, older of the two ties
      "ask:ask-narrow-newer", // blast radius 1, newer
      "block:block-old", // no blast-radius signal: always after every ask
      "block:block-new",
    ],
  );
});

test("isHardList matches the hard list case-insensitively, mirroring is_hard_list_category", () => {
  const items = buildActionCenterItems({
    asks: [
      ask("ask-spend", { category: "SPEND" }),
      ask("ask-mixed-case", { category: "External_Send" }),
      ask("ask-ordinary", { category: "onboarding" }),
      ask("ask-none", { category: null }),
    ],
    reminders: [],
  });

  const isHardListById = new Map(
    items.map((item) => [item.id, item.source.isHardList]),
  );
  assert.equal(isHardListById.get("ask:ask-spend"), true);
  assert.equal(isHardListById.get("ask:ask-mixed-case"), true);
  assert.equal(isHardListById.get("ask:ask-ordinary"), false);
  assert.equal(isHardListById.get("ask:ask-none"), false);
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
