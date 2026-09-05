import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createWorkContextResolver,
  mergeWorkContextTags,
  workContextTags,
} from "./workContext.ts";

const RELAY = "a".repeat(64);
const AGENT = "b".repeat(64);
const TASK_ID = "thread-task:6f1d2b3c-0000-4000-8000-000000000001";
const HEAD_EVENT_ID = "h".repeat(64);

function task(overrides = {}) {
  return {
    schema: "colony.task/v1",
    id: TASK_ID,
    initiativeId: null,
    title: "Take a look at the failing deploy",
    status: "inProgress",
    owningTeamId: "company-team:abc:horizonlabs:engineering",
    assigneePersonaIds: ["company-role:abc:horizonlabs:cto"],
    qaPersonaId: "company-role:abc:horizonlabs:cto",
    reviewerTeamId: null,
    costCentreId: "cc-coordination",
    commercialPurpose: "administration",
    clientOrganizationId: null,
    sourceChannelId: "engineering",
    sourceEventId: null,
    implicit: true,
    threadRoot: null,
    reportedCompleteBy: [],
    hidden: false,
    parentTaskId: null,
    createdAt: 1_780_000_000,
    updatedAt: 1_780_000_000,
    ...overrides,
  };
}

const REQUEST = {
  channelId: "engineering",
  sendId: "send-0001",
  agentPubkey: AGENT,
  title: "Take a look at the failing deploy",
  mode: "open",
};

function resolver({
  brokerOutcome = {
    status: "applied",
    receiptEventId: "r".repeat(64),
    headEventId: HEAD_EVENT_ID,
    target: "t",
  },
  taskResult = { ok: true, value: task() },
  headForAction = async () => null,
} = {}) {
  const order = [];
  const attachCalls = [];
  const loadTaskCalls = [];
  const resolve = createWorkContextResolver({
    relaySelf: async () => RELAY,
    attach: async (input) => {
      order.push("attach");
      attachCalls.push(input);
      assert.equal(input.sendId, "send-0001");
      assert.equal(input.relayPubkey, RELAY);
      return { signedAction: "signed-action" };
    },
    broker: {
      submit: async () => {
        order.push("publish");
        return brokerOutcome;
      },
    },
    headForAction,
    loadTask: async (headEventId) => {
      order.push("read-back");
      loadTaskCalls.push(headEventId);
      return taskResult;
    },
  });
  return { resolve, order, attachCalls, loadTaskCalls };
}

// The client proposes no task id: the relay decides which task the send
// belongs to, and the answer only exists once the question has been asked.
test("the task is confirmed by the relay before the message has any tags", async () => {
  const { resolve, order } = resolver();
  const context = await resolve(REQUEST);
  assert.deepEqual(order, ["attach", "publish", "read-back"]);
  assert.deepEqual(context, {
    taskId: TASK_ID,
    initiativeId: null,
    owningTeamId: "company-team:abc:horizonlabs:engineering",
    hidden: false,
    tags: [
      ["task", TASK_ID],
      ["team", "company-team:abc:horizonlabs:engineering"],
    ],
  });
});

test("a task inside an initiative carries all three references", () => {
  assert.deepEqual(
    workContextTags(task({ initiativeId: "horizonlabs:launch-outbound" })),
    [
      ["task", TASK_ID],
      ["initiative", "horizonlabs:launch-outbound"],
      ["team", "company-team:abc:horizonlabs:engineering"],
    ],
  );
});

// Cost centre, client, purpose, and classification are properties of the Task.
// A prompt that carried them would be a prompt that could lie about them.
test("nothing but the three references reaches the message", () => {
  const tags = workContextTags(task());
  assert.deepEqual(tags.map((tag) => tag[0]).sort(), ["task", "team"]);
});

test("merging replaces any work reference the caller already had", () => {
  const merged = mergeWorkContextTags(
    [
      ["h", "engineering"],
      ["task", "someone-elses-task"],
      ["team", "someone-elses-team"],
      ["p", AGENT],
    ],
    workContextTags(task()),
  );
  assert.deepEqual(merged, [
    ["h", "engineering"],
    ["p", AGENT],
    ["task", TASK_ID],
    ["team", "company-team:abc:horizonlabs:engineering"],
  ]);
  assert.equal(merged.filter((tag) => tag[0] === "task").length, 1);
  assert.equal(merged.filter((tag) => tag[0] === "team").length, 1);
});

// An applied receipt names the task head this send resolved to, including
// when the relay attached to a task that already existed: it points at the
// head already stored rather than rewriting it to say the same thing.
test("an applied receipt's head event id is what the task is read back by", async () => {
  const { resolve, loadTaskCalls } = resolver();
  await resolve(REQUEST);
  assert.deepEqual(loadTaskCalls, [HEAD_EVENT_ID]);
});

// The relay recognised this exact send as a replay of an earlier attempt.
// That is the goal state a retry was trying to reach, and the winning
// action's own receipt names the task it was answered with.
test("a superseded submission reads the winning action's task", async () => {
  const seen = [];
  const { resolve, loadTaskCalls } = resolver({
    brokerOutcome: {
      status: "superseded",
      actionEventId: "a".repeat(64),
      winnerEventId: "w".repeat(64),
      message: "This exact change was already applied by an earlier attempt.",
    },
    headForAction: async (actionEventId) => {
      seen.push(actionEventId);
      return HEAD_EVENT_ID;
    },
  });
  const context = await resolve(REQUEST);
  assert.deepEqual(seen, ["w".repeat(64)]);
  assert.deepEqual(loadTaskCalls, [HEAD_EVENT_ID]);
  assert.equal(context.taskId, TASK_ID);
});

// A superseded claim is only evidence that SOME attempt won it. If the task
// it produced cannot be named, this must fail honestly rather than assume a
// success it never confirmed.
test("a superseded claim whose task cannot be named stops the send", async () => {
  const { resolve } = resolver({
    brokerOutcome: {
      status: "superseded",
      actionEventId: "a".repeat(64),
      winnerEventId: "w".repeat(64),
      message: "This exact change was already applied by an earlier attempt.",
    },
    headForAction: async () => null,
  });
  await assert.rejects(() => resolve(REQUEST), /has not been sent/i);
});

test("an unrecorded task stops the send rather than buying an unattributed turn", async () => {
  for (const outcome of [
    {
      status: "no-receipt",
      actionEventId: "a".repeat(64),
      message: "The relay has not answered this company change yet.",
    },
    {
      status: "rejected",
      receiptEventId: "r".repeat(64),
      target: "t",
      message: "The relay refused this company change.",
    },
    {
      status: "conflict",
      receiptEventId: "r".repeat(64),
      target: "t",
      message: "This record changed while the request was in flight.",
    },
    {
      status: "failed",
      receiptEventId: "r".repeat(64),
      target: "t",
      message: "The relay refused this company change.",
    },
  ]) {
    await assert.rejects(
      () => resolver({ brokerOutcome: outcome }).resolve(REQUEST),
      /has not been sent/i,
      `${outcome.status} must stop the send`,
    );
  }
});

// The head is what the harness re-reads. A message pinned to a task this
// client never confirmed would attribute a turn to work the relay never
// stored.
test("a task that cannot be read back stops the send", async () => {
  const { resolve } = resolver({
    taskResult: { ok: false, code: "missing-head", message: "gone" },
  });
  await assert.rejects(() => resolve(REQUEST), /has not been sent/i);
});

test("no relay identity stops the send", async () => {
  const withoutRelay = createWorkContextResolver({
    relaySelf: async () => null,
    attach: async () => {
      throw new Error("must not be reached");
    },
    broker: {
      submit: async () => {
        throw new Error("must not be reached");
      },
    },
    headForAction: async () => null,
    loadTask: async () => ({ ok: true, value: task() }),
  });
  await assert.rejects(() => withoutRelay(REQUEST), /no stable identity/i);
});

const THREAD_ROOT = "5910f909".padEnd(64, "a");

// The relay keys a thread by its root, so this is what makes the second
// message in a conversation join the task the first one opened.
test("a thread reply forwards its thread root and its mode", async () => {
  const { resolve, attachCalls } = resolver();
  await resolve({ ...REQUEST, threadRoot: THREAD_ROOT, mode: "attach" });
  assert.equal(attachCalls.length, 1);
  assert.equal(attachCalls[0].threadRoot, THREAD_ROOT);
  assert.equal(attachCalls[0].mode, "attach");
  assert.equal(attachCalls[0].conversationScope, false);
});

// A send that starts its own thread has no root yet: the relay claims it
// under the send id and rebinds that claim when the message arrives.
test("a send at channel root forwards no thread root", async () => {
  const { resolve, attachCalls } = resolver();
  await resolve(REQUEST);
  assert.equal(attachCalls[0].threadRoot, null);
  assert.equal(attachCalls[0].mode, "open");
});

// A DM is one thread for its whole life, so the relay keys it by the
// conversation rather than by any root inside it.
test("a DM asks for conversation scope", async () => {
  const { resolve, attachCalls } = resolver();
  await resolve({ ...REQUEST, conversationScope: true, threadRoot: null });
  assert.equal(attachCalls[0].conversationScope, true);
  assert.equal(attachCalls[0].threadRoot, null);
});

// The turn still has to be charged, so the send proceeds and the message
// carries the hidden task's id like any other.
test("a turn charged to the hidden chat task still tags the message", async () => {
  const { resolve } = resolver({
    taskResult: { ok: true, value: task({ hidden: true }) },
  });
  const context = await resolve({ ...REQUEST, mode: "attach" });
  assert.equal(context.hidden, true);
  assert.deepEqual(context.tags[0], ["task", TASK_ID]);
});
