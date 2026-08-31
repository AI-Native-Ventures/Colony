import assert from "node:assert/strict";
import { test } from "node:test";

import { createTaskCreator } from "./createTask.ts";

const RELAY = "a".repeat(64);
const ASSIGNEE_PERSONA_ID = "persona-cto";
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
    loadTask: async (taskId, headEventId) => {
      calls.loadTask.push([taskId, headEventId]);
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
    assigneePersonaId: ASSIGNEE_PERSONA_ID,
  });
  assert.equal(task.id, "horizonlabs:task-1");
  assert.equal(calls.createUserTask.length, 1);
  // The title reaching the backend is trimmed, not the raw form value.
  assert.equal(calls.createUserTask[0].title, "Ship the thing");
  assert.equal(calls.createUserTask[0].channelId, CHANNEL_ID);
  assert.equal(calls.createUserTask[0].relayPubkey, RELAY);
  assert.equal(calls.submit.length, 1);
  assert.equal(calls.loadTask.length, 1);
  // The applied receipt's head event id reaches the read-back, so it can
  // read the exact event the relay just wrote instead of waiting on a tag
  // index to catch up.
  assert.deepEqual(calls.loadTask[0], ["horizonlabs:task-1", "h".repeat(64)]);
});

test("an invalid form never reaches the network", async () => {
  const { creator, calls } = stack();
  await assert.rejects(
    () =>
      creator({
        channelId: "",
        title: "Ship the thing",
        requestId: "11111111-1111-4111-8111-111111111111",
        assigneePersonaId: ASSIGNEE_PERSONA_ID,
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
    assigneePersonaId: ASSIGNEE_PERSONA_ID,
  });
  assert.equal(task.id, "horizonlabs:task-1");
  assert.equal(calls.loadTask.length, 1);
  // A conflict names no head, so the read-back falls back to its ordinary
  // coordinate lookup rather than being handed a stale or absent id.
  assert.deepEqual(calls.loadTask[0], ["horizonlabs:task-1", null]);
});

// The relay's idempotency claim on this request id was already won - by an
// earlier attempt at this exact create, most likely. `planned.taskId` is
// derived from `requestId`, not from which event won the claim, so it names
// the same Task either way: the same goal state a "conflict" reaches.
test("a superseded submission is treated the same as applied - the task already exists", async () => {
  const { creator, calls } = stack({
    brokerOutcome: {
      status: "superseded",
      actionEventId: "a".repeat(64),
      winnerEventId: "w".repeat(64),
      message: "This exact change was already applied by an earlier attempt.",
    },
  });
  const task = await creator({
    channelId: CHANNEL_ID,
    title: "Ship the thing",
    requestId: "11111111-1111-4111-8111-111111111111",
    assigneePersonaId: ASSIGNEE_PERSONA_ID,
  });
  assert.equal(task.id, "horizonlabs:task-1");
  assert.equal(calls.loadTask.length, 1);
  // The relay's rejection names the exact event that won the claim, so the
  // read-back goes straight to it.
  assert.deepEqual(calls.loadTask[0], ["horizonlabs:task-1", "w".repeat(64)]);
});

// A superseded claim is only evidence that SOME attempt won it. If the Task
// it produced genuinely cannot be read back, this must still fail honestly.
test("a superseded submission whose task never appears still fails honestly", async () => {
  const { creator } = stack({
    brokerOutcome: {
      status: "superseded",
      actionEventId: "a".repeat(64),
      winnerEventId: "w".repeat(64),
      message: "This exact change was already applied by an earlier attempt.",
    },
    loadTask: { ok: false, code: "missing-head", message: "gone" },
  });
  await assert.rejects(
    () =>
      creator({
        channelId: CHANNEL_ID,
        title: "Ship the thing",
        requestId: "11111111-1111-4111-8111-111111111111",
        assigneePersonaId: ASSIGNEE_PERSONA_ID,
      }),
    /could not be read back/i,
  );
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
        assigneePersonaId: ASSIGNEE_PERSONA_ID,
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
        assigneePersonaId: ASSIGNEE_PERSONA_ID,
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
        assigneePersonaId: ASSIGNEE_PERSONA_ID,
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
        assigneePersonaId: ASSIGNEE_PERSONA_ID,
      }),
    /no company record|has not described its business/i,
  );
  assert.equal(built, false);
});

test("the chosen assignee reaches the backend as the task's only assignee", async () => {
  const { creator, calls } = stack();
  await creator({
    channelId: CHANNEL_ID,
    title: "Ship the thing",
    requestId: "11111111-1111-4111-8111-111111111111",
    assigneePersonaId: ASSIGNEE_PERSONA_ID,
  });
  assert.deepEqual(calls.createUserTask[0].assigneePersonaIds, [
    ASSIGNEE_PERSONA_ID,
  ]);
});

test("a task with no assignee never reaches the backend", async () => {
  const { creator, calls } = stack();
  await assert.rejects(
    () =>
      creator({
        channelId: CHANNEL_ID,
        title: "Ship the thing",
        requestId: "11111111-1111-4111-8111-111111111111",
        assigneePersonaId: "",
      }),
    /Choose who does this task/i,
  );
  assert.equal(calls.createUserTask.length, 0);
});
