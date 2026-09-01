import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createWorkContextResolver,
  mergeWorkContextTags,
  workContextTags,
} from "./workContext.ts";

const RELAY = "a".repeat(64);
const AGENT = "b".repeat(64);
const TASK_ID = "horizonlabs:chat:6f1d2b3c-0000-4000-8000-000000000001";

const COMPANY_HEAD = {
  id: "c".repeat(64),
  pubkey: RELAY,
  created_at: 1_780_000_100,
  kind: 30179,
  tags: [["d", "horizonlabs"]],
  content: "{}",
  sig: "0".repeat(128),
};

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
};

function resolver({
  brokerOutcome = {
    status: "applied",
    receiptEventId: "r".repeat(64),
    headEventId: "h".repeat(64),
    target: "t",
  },
  taskResult = { ok: true, value: task() },
  companyHead = COMPANY_HEAD,
} = {}) {
  const order = [];
  const loadTaskCalls = [];
  const resolve = createWorkContextResolver({
    relaySelf: async () => RELAY,
    fetchCompanyHead: async () => companyHead,
    ensureTask: async (input) => {
      order.push("ensure");
      assert.equal(input.sendId, "send-0001");
      assert.equal(input.relayPubkey, RELAY);
      return {
        taskId: TASK_ID,
        owningTeamId: "company-team:abc:horizonlabs:engineering",
        signedAction: "signed-action",
      };
    },
    broker: {
      submit: async () => {
        order.push("publish");
        return brokerOutcome;
      },
    },
    loadTask: async (taskId, headEventId) => {
      order.push("read-back");
      loadTaskCalls.push([taskId, headEventId]);
      return taskResult;
    },
  });
  return { resolve, order, loadTaskCalls };
}

test("the task is created and confirmed before the message has any tags", async () => {
  const { resolve, order } = resolver();
  const context = await resolve(REQUEST);
  assert.deepEqual(order, ["ensure", "publish", "read-back"]);
  assert.deepEqual(context, {
    taskId: TASK_ID,
    initiativeId: null,
    owningTeamId: "company-team:abc:horizonlabs:engineering",
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

// The Task already existing is the state this was trying to reach, so a replay
// of the same send is a success rather than a reason to refuse to send.
test("a conflict means the task is already there, and the send proceeds", async () => {
  const { resolve } = resolver({
    brokerOutcome: {
      status: "conflict",
      receiptEventId: "r".repeat(64),
      target: "t",
      message: "This record changed while the request was in flight.",
    },
  });
  const context = await resolve(REQUEST);
  assert.equal(context.taskId, TASK_ID);
});

// An applied receipt names the exact event the relay just wrote. Reading it
// by that id, rather than waiting on the `#d` tag filter to catch up, is
// what a single-shot `getTask` had no way to do.
test("an applied receipt's head event id is handed to the read-back", async () => {
  const { resolve, loadTaskCalls } = resolver({
    brokerOutcome: {
      status: "applied",
      receiptEventId: "r".repeat(64),
      headEventId: "h".repeat(64),
      target: "t",
    },
  });
  await resolve(REQUEST);
  assert.deepEqual(loadTaskCalls, [[TASK_ID, "h".repeat(64)]]);
});

// A conflict receipt names no head, so the read-back falls back to its
// ordinary coordinate lookup rather than being handed a stale or absent id.
test("a conflict carries no head event id to the read-back", async () => {
  const { resolve, loadTaskCalls } = resolver({
    brokerOutcome: {
      status: "conflict",
      receiptEventId: "r".repeat(64),
      target: "t",
      message: "This record changed while the request was in flight.",
    },
  });
  await resolve(REQUEST);
  assert.deepEqual(loadTaskCalls, [[TASK_ID, null]]);
});

// The relay's idempotency claim on this send was already won - by an
// earlier attempt at this exact send, most likely, since `created_at` is
// real wall-clock time and every retry signs a different event id.
// `planned.taskId` is derived from the send itself (channel + send id), not
// from which event won the claim, so it names the same Task either way:
// this is the same goal state a "conflict" reaches, not a failure.
test("a superseded submission means the send already succeeded, and proceeds", async () => {
  const { resolve } = resolver({
    brokerOutcome: {
      status: "superseded",
      actionEventId: "a".repeat(64),
      winnerEventId: "w".repeat(64),
      message: "This exact change was already applied by an earlier attempt.",
    },
  });
  const context = await resolve(REQUEST);
  assert.equal(context.taskId, TASK_ID);
});

// The relay's rejection names the exact event that won the claim, so the
// read-back can go straight to it instead of waiting on the `#d` tag filter.
test("a superseded claim's winning event id is handed to the read-back", async () => {
  const { resolve, loadTaskCalls } = resolver({
    brokerOutcome: {
      status: "superseded",
      actionEventId: "a".repeat(64),
      winnerEventId: "w".repeat(64),
      message: "This exact change was already applied by an earlier attempt.",
    },
  });
  await resolve(REQUEST);
  assert.deepEqual(loadTaskCalls, [[TASK_ID, "w".repeat(64)]]);
});

// A superseded claim is only evidence that SOME attempt won it. If the Task
// it produced genuinely cannot be read back - a bug, a wrong community, a
// claim for something else entirely - this must still fail honestly rather
// than assume success it never confirmed.
test("a superseded submission whose task never appears still fails honestly", async () => {
  const { resolve } = resolver({
    brokerOutcome: {
      status: "superseded",
      actionEventId: "a".repeat(64),
      winnerEventId: "w".repeat(64),
      message: "This exact change was already applied by an earlier attempt.",
    },
    taskResult: { ok: false, code: "missing-head", message: "gone" },
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

// The head is what the harness re-reads. A message pinned to a Task this
// client never confirmed would attribute a turn to work the relay never stored.
test("a task that cannot be read back stops the send", async () => {
  const { resolve } = resolver({
    taskResult: { ok: false, code: "missing-head", message: "gone" },
  });
  await assert.rejects(() => resolve(REQUEST), /has not been sent/i);
});

test("no profile and no relay identity both stop the send", async () => {
  await assert.rejects(
    () => resolver({ companyHead: null }).resolve(REQUEST),
    /has not described its business/i,
  );

  const withoutRelay = createWorkContextResolver({
    relaySelf: async () => null,
    fetchCompanyHead: async () => COMPANY_HEAD,
    ensureTask: async () => {
      throw new Error("must not be reached");
    },
    broker: {
      submit: async () => {
        throw new Error("must not be reached");
      },
    },
    loadTask: async () => ({ ok: true, value: task() }),
  });
  await assert.rejects(() => withoutRelay(REQUEST), /no stable identity/i);
});
