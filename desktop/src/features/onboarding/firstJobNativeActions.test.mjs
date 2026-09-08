import assert from "node:assert/strict";
import { test } from "node:test";
import { createFirstJobWorkValidator } from "./firstJobNativeActions.ts";

const scope = {
  ownerPubkey: "a".repeat(64),
  relayUrl: "wss://business.test",
  channelId: "welcome",
  threadRootId: "b".repeat(64),
  requestId: "first-job",
};
const team = { scoutPubkey: "c".repeat(64), workerPubkey: "d".repeat(64) };
const work = {
  actionId: "e".repeat(64),
  taskId: "task-one",
  tags: [
    ["task", "task-one"],
    ["team", "coordination"],
  ],
  createdAt: 1000,
};
const task = {
  id: work.taskId,
  status: "inProgress",
  hidden: false,
  threadRoot: scope.threadRootId,
  sourceChannelId: scope.channelId,
  owningTeamId: "coordination",
  initiativeId: null,
  assigneePersonaIds: ["builtin:fizz"],
};

function fixture(change = {}) {
  const calls = [];
  let active = true;
  const deps = {
    assertCurrent: async () => {
      if (!active) throw new Error("scope changed");
    },
    loadTask: async (taskId) => {
      calls.push(taskId);
      return { ok: true, value: { ...task, ...change } };
    },
    listAgents: async () => [
      {
        pubkey: team.scoutPubkey,
        relayUrl: scope.relayUrl,
        personaId: "builtin:fizz",
      },
    ],
  };
  return {
    deps,
    calls,
    stale: () => {
      active = false;
    },
    validate: () => createFirstJobWorkValidator(deps)(scope, team, work),
  };
}

test("current canonical task is loaded by stable task ID on every validation", async () => {
  const f = fixture();
  await f.validate();
  await f.validate();
  assert.deepEqual(f.calls, [work.taskId, work.taskId]);
});

for (const [label, change] of Object.entries({
  cancelled: { status: "cancelled" },
  completed: { status: "completed" },
  hidden: { hidden: true },
  "wrong thread": { threadRoot: "f".repeat(64) },
  "wrong channel": { sourceChannelId: "another" },
  "wrong id": { id: "different-task" },
  "changed team": { owningTeamId: "different-team" },
  "changed initiative": { initiativeId: "new-initiative" },
  reassigned: { assigneePersonaIds: ["another-persona"] },
})) {
  test(`current ${label} task cannot authorize the saved instruction`, async () => {
    await assert.rejects(fixture(change).validate(), /task|assigned/);
  });
}

test("an unreadable current task and a missing or moved Scout stay blocked", async () => {
  const f = fixture();
  f.deps.loadTask = async () => ({
    ok: false,
    code: "unavailable",
    message: "offline",
  });
  await assert.rejects(f.validate(), /could not be checked/);
  for (const agents of [
    [],
    [
      {
        pubkey: team.scoutPubkey,
        relayUrl: "wss://other.test",
        personaId: "builtin:fizz",
      },
    ],
    [
      {
        pubkey: team.scoutPubkey,
        relayUrl: scope.relayUrl,
        personaId: "new-persona",
      },
    ],
  ]) {
    const other = fixture();
    other.deps.listAgents = async () => agents;
    await assert.rejects(other.validate(), /no longer assigned/);
  }
});

for (const step of ["loadTask", "listAgents"]) {
  test(`identity change during ${step} cannot validate the old work`, async () => {
    const f = fixture();
    const original = f.deps[step];
    f.deps[step] = async (...args) => {
      const value = await original(...args);
      f.stale();
      return value;
    };
    await assert.rejects(f.validate(), /scope changed/);
  });
}
