import assert from "node:assert/strict";
import { test } from "node:test";

import { createTaskCreator } from "./createTask.ts";

const RELAY = "a".repeat(64);
const CHANNEL_ID = "general";

function companyHeadEvent() {
  return {
    id: "c".repeat(64),
    pubkey: RELAY,
    created_at: 1_780_000_100,
    kind: 30179,
    tags: [["d", "profile"]],
    content: "{}",
    sig: "0".repeat(128),
  };
}

function companyTask(overrides = {}) {
  return {
    schema: "colony.task/v1",
    id: "horizonlabs:task-1",
    initiativeId: null,
    title: "Ship the thing",
    status: "ready",
    owningTeamId: "relay1:horizonlabs:coordination",
    assigneePersonaIds: [],
    qaPersonaId: "relay1:horizonlabs:coordination-lead",
    reviewerTeamId: null,
    costCentreId: "cc-internal",
    commercialPurpose: "internal",
    clientOrganizationId: null,
    sourceChannelId: CHANNEL_ID,
    sourceEventId: null,
    implicit: false,
    dependsOn: [],
    subject: null,
    stage: null,
    threadRoot: null,
    doerKind: "agent",
    wakeAt: null,
    createdAt: 1_780_000_100,
    updatedAt: 1_780_000_100,
    ...overrides,
  };
}

/** A working stack: identity, company head, backend build, applied receipt. */
function stack({ brokerOutcome, loadTask } = {}) {
  const calls = { createUserTask: [], submit: [], loadTask: [] };
  const creator = createTaskCreator({
    relaySelf: async () => RELAY,
    fetchCompanyHead: async () => companyHeadEvent(),
    createUserTask: async (input) => {
      calls.createUserTask.push(input);
      return {
        taskId: "horizonlabs:task-1",
        owningTeamId: "relay1:horizonlabs:coordination",
        signedAction: "signed-action",
      };
    },
    broker: {
      submit: async (action) => {
        calls.submit.push(action);
        return (
          brokerOutcome ?? {
            status: "applied",
            receiptEventId: "r".repeat(64),
            headEventId: "h".repeat(64),
            target: "t",
          }
        );
      },
    },
    loadTask: async (taskId) => {
      calls.loadTask.push(taskId);
      return (
        loadTask ?? {
          ok: true,
          value: companyTask({ id: taskId }),
        }
      );
    },
  });
  return { creator, calls };
}

test("a valid submission publishes the signed action and reads the task back", async () => {
  const { creator, calls } = stack();
  const task = await creator({
    channelId: CHANNEL_ID,
    title: "  Ship the thing  ",
    requestId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(task.id, "horizonlabs:task-1");
  assert.equal(calls.createUserTask.length, 1);
  // The title reaching the backend is trimmed, not the raw form value.
  assert.equal(calls.createUserTask[0].title, "Ship the thing");
  assert.equal(calls.createUserTask[0].channelId, CHANNEL_ID);
  assert.equal(calls.createUserTask[0].relayPubkey, RELAY);
  assert.equal(calls.submit.length, 1);
  assert.equal(calls.loadTask.length, 1);
});

test("an invalid form never reaches the network", async () => {
  const { creator, calls } = stack();
  await assert.rejects(
    () =>
      creator({
        channelId: "",
        title: "Ship the thing",
        requestId: "11111111-1111-4111-8111-111111111111",
      }),
    /choose a channel/i,
  );
  assert.equal(calls.createUserTask.length, 0);
  assert.equal(calls.submit.length, 0);
});

test("a conflict is treated the same as applied - the task already exists", async () => {
  const { creator, calls } = stack({
    brokerOutcome: {
      status: "conflict",
      receiptEventId: "r".repeat(64),
      target: "t",
      message: "This record changed while the request was in flight.",
    },
  });
  const task = await creator({
    channelId: CHANNEL_ID,
    title: "Ship the thing",
    requestId: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(task.id, "horizonlabs:task-1");
  assert.equal(calls.loadTask.length, 1);
});

test("a rejected action surfaces the relay's message rather than pretending success", async () => {
  const { creator } = stack({
    brokerOutcome: {
      status: "rejected",
      receiptEventId: "r".repeat(64),
      target: "t",
      message: "The relay refused this company change.",
    },
  });
  await assert.rejects(
    () =>
      creator({
        channelId: CHANNEL_ID,
        title: "Ship the thing",
        requestId: "11111111-1111-4111-8111-111111111111",
      }),
    /refused this company change/i,
  );
});

test("an unanswered action is reported as unresolved, not as a create", async () => {
  const { creator } = stack({
    brokerOutcome: {
      status: "no-receipt",
      actionEventId: "a".repeat(64),
      message: "The relay has not answered this company change yet.",
    },
  });
  await assert.rejects(
    () =>
      creator({
        channelId: CHANNEL_ID,
        title: "Ship the thing",
        requestId: "11111111-1111-4111-8111-111111111111",
      }),
    /has not answered/i,
  );
});

test("a community with no relay identity cannot create anything", async () => {
  const creator = createTaskCreator({
    relaySelf: async () => null,
    fetchCompanyHead: async () => {
      throw new Error("must not be reached");
    },
    createUserTask: async () => {
      throw new Error("must not be reached");
    },
    broker: {
      submit: async () => {
        throw new Error("must not be reached");
      },
    },
    loadTask: async () => {
      throw new Error("must not be reached");
    },
  });
  await assert.rejects(
    () =>
      creator({
        channelId: CHANNEL_ID,
        title: "Ship the thing",
        requestId: "11111111-1111-4111-8111-111111111111",
      }),
    /no stable identity/i,
  );
});

test("a missing company head stops before anything is signed", async () => {
  let built = false;
  const creator = createTaskCreator({
    relaySelf: async () => RELAY,
    fetchCompanyHead: async () => null,
    createUserTask: async () => {
      built = true;
      throw new Error("must not be reached");
    },
    broker: {
      submit: async () => {
        throw new Error("must not be reached");
      },
    },
    loadTask: async () => {
      throw new Error("must not be reached");
    },
  });
  await assert.rejects(
    () =>
      creator({
        channelId: CHANNEL_ID,
        title: "Ship the thing",
        requestId: "11111111-1111-4111-8111-111111111111",
      }),
    /no company record|has not described its business/i,
  );
  assert.equal(built, false);
});
