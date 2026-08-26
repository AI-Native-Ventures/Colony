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
    companyId: "horizonlabs",
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
  companyId: "horizonlabs",
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
    loadTask: async () => {
      order.push("read-back");
      return taskResult;
    },
  });
  return { resolve, order };
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

test("no company and no relay identity both stop the send", async () => {
  await assert.rejects(
    () => resolver({ companyHead: null }).resolve(REQUEST),
    /no company/i,
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
