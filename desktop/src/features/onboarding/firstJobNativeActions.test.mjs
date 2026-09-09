import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFirstJobMessagePreparer,
  createFirstJobWorkValidator,
} from "./firstJobNativeActions.ts";

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

function messageFixture() {
  let active = true;
  const signed = [];
  const deps = {
    assertCurrent: async () => {
      if (!active) throw new Error("scope changed");
    },
    listAgents: async () => [
      {
        pubkey: team.workerPubkey,
        relayUrl: "wss://other.test",
        name: "Other business",
      },
      {
        pubkey: team.workerPubkey,
        relayUrl: scope.relayUrl,
        name: "Sarah Jones",
      },
    ],
    signMessage: async (input) => {
      signed.push(input);
      return { ...input, id: "f".repeat(64), pubkey: scope.ownerPubkey };
    },
  };
  return {
    deps,
    signed,
    stale: () => {
      active = false;
    },
    prepare: () =>
      createFirstJobMessagePreparer(deps)({
        scope,
        team,
        work,
        content: "Review this brief.",
      }),
  };
}

test("instruction preparation snapshots the selected same-business worker name without notifying it", async () => {
  const f = messageFixture();
  const message = await f.prepare();
  assert.match(message.content, /Ask @Sarah Jones to do the work/);
  assert.doesNotMatch(message.content, /Other business|nostr:|npub1/);
  assert.deepEqual(
    message.tags.filter((tag) => tag[0] === "p"),
    [["p", team.scoutPubkey]],
  );
  assert.deepEqual(
    message.tags.filter((tag) => tag[0] === "mention"),
    [["mention", team.workerPubkey]],
  );
  assert.deepEqual(
    message.tags.filter((tag) => ["task", "team"].includes(tag[0])),
    work.tags,
  );
  assert.deepEqual(
    message.tags.find((tag) => tag[0] === "e"),
    ["e", scope.threadRootId, "", "reply"],
  );
});

test("missing same-business name remains readable and keeps exact worker identity only in the reference tag", async () => {
  const f = messageFixture();
  f.deps.listAgents = async () => [
    {
      pubkey: team.workerPubkey,
      relayUrl: "wss://other.test",
      name: "Other business",
    },
  ];
  const message = await f.prepare();
  assert.match(message.content, /Ask the approved worker to do the work/);
  assert.doesNotMatch(message.content, /Other business|nostr:|npub1/);
  assert.deepEqual(
    message.tags.filter((tag) => tag[0] === "mention"),
    [["mention", team.workerPubkey]],
  );
});

for (const step of ["listAgents", "signMessage"]) {
  test(`scope change during name preparation ${step} cannot return a publishable old-scope instruction`, async () => {
    const f = messageFixture();
    const original = f.deps[step];
    f.deps[step] = async (...args) => {
      const value = await original(...args);
      f.stale();
      return value;
    };
    await assert.rejects(f.prepare(), /scope changed/);
    assert.equal(f.signed.length, step === "listAgents" ? 0 : 1);
  });
}
