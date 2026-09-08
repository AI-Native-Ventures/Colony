import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFirstJobDispatcher,
  FirstJobTaskRefused,
} from "./firstJobDispatch.ts";

const scope = {
  ownerPubkey: "a".repeat(64),
  relayUrl: "wss://horizon.example",
  channelId: "welcome",
  threadRootId: "b".repeat(64),
  requestId: "attempt-1",
};
const team = { scoutPubkey: "c".repeat(64), workerPubkey: "d".repeat(64) };
const input = { scope, team, content: "Draft a week of social post ideas." };
const event = (id, kind = 9) => ({
  id: id.repeat(64),
  pubkey: scope.ownerPubkey,
  created_at: 1000,
  kind,
  content: input.content,
  tags: [],
  sig: "e".repeat(128),
});
const action = event("f", 40000);
const work = {
  actionId: action.id,
  taskId: "task-one",
  tags: [
    ["task", "task-one"],
    ["team", "coordination"],
  ],
  createdAt: 1000,
};
const outgoing = {
  ...event("1"),
  tags: [
    ["h", scope.channelId],
    ["e", scope.threadRootId, "", "reply"],
    ["p", team.scoutPubkey],
    ...work.tags,
  ],
};

function fixture(overrides = {}) {
  let record = null;
  let tail = Promise.resolve();
  const calls = [];
  const effects = new Map();
  const deps = {
    now: () => 1_000_000,
    assertCurrent: async () => {},
    withLock: async (_scope, callback) => {
      const prior = tail;
      let release;
      tail = new Promise((resolve) => {
        release = resolve;
      });
      await prior;
      try {
        return await callback();
      } finally {
        release();
      }
    },
    read: () => record && structuredClone(record),
    write: (_scope, value) => {
      record = structuredClone(value);
      calls.push(
        `save:${value.acknowledged ? "ack" : value.message ? "message" : value.work ? "task" : value.action ? "action" : "attempt"}`,
      );
    },
    plan: async () => {
      calls.push("plan");
      return action;
    },
    resolveWork: async () => {
      calls.push("task");
      return work;
    },
    validateWork: async () => {},
    startTeam: async () => {
      calls.push("start");
    },
    prepareMessage: async () => {
      calls.push("sign");
      return outgoing;
    },
    publish: async (_scope, value) => {
      calls.push("publish");
      effects.set(value.id, JSON.stringify(value));
    },
    ...overrides,
  };
  return { deps, calls, effects, read: () => record };
}

test("an exact authoritative refusal prepares a new revision only on the next explicit retry", async () => {
  const revisions = [];
  let refused = true;
  const f = fixture({
    plan: async ({ revision }) => {
      revisions.push(revision);
      return revision ? event("2", 40000) : action;
    },
    resolveWork: async (_scope, submitted) => {
      if (refused) {
        refused = false;
        throw new FirstJobTaskRefused(submitted.id);
      }
      return { ...work, actionId: submitted.id };
    },
  });
  const dispatch = createFirstJobDispatcher(f.deps);
  await assert.rejects(dispatch(input), FirstJobTaskRefused);
  assert.equal(f.read().action, null);
  assert.equal(f.read().revision, 1);
  assert.equal(f.effects.size, 0);
  assert.deepEqual(revisions, [0]);
  await dispatch(input);
  assert.deepEqual(revisions, [0, 1]);
  assert.equal(f.effects.size, 1);
});

test("an unknown result or refusal for another action retains the exact saved action", async () => {
  for (const error of [
    new Error("receipt unavailable"),
    new FirstJobTaskRefused("9".repeat(64)),
  ]) {
    const f = fixture({
      resolveWork: async () => {
        throw error;
      },
    });
    await assert.rejects(
      createFirstJobDispatcher(f.deps)(input),
      (value) => value === error,
    );
    assert.equal(f.read().action.id, action.id);
    assert.equal(f.read().revision ?? 0, 0);
    assert.equal(f.effects.size, 0);
  }
});

test("signed action and message are durable before their publication, task before execution", async () => {
  const { deps, calls } = fixture();
  const result = await createFirstJobDispatcher(deps)(input);
  assert.deepEqual(result, { eventId: outgoing.id, taskId: work.taskId });
  assert.deepEqual(calls, [
    "save:attempt",
    "plan",
    "save:action",
    "task",
    "save:task",
    "start",
    "sign",
    "save:message",
    "publish",
    "save:ack",
  ]);
});

test("a message signed after delayed readiness can be newer than its accepted task action", async () => {
  const f = fixture({
    prepareMessage: async () => ({ ...outgoing, created_at: 1015 }),
  });
  await createFirstJobDispatcher(f.deps)(input);
  assert.equal(f.read().message.created_at, 1015);
  assert.equal(f.effects.size, 1);
});

test("a message predating its task cannot be published", async () => {
  const f = fixture({
    prepareMessage: async () => ({ ...outgoing, created_at: 999 }),
  });
  await assert.rejects(
    createFirstJobDispatcher(f.deps)(input),
    /could not be verified/,
  );
  assert.equal(f.effects.size, 0);
});

test("an old unconfirmed instruction cannot restart workers or silently create a fresh message", async () => {
  let now = 1_000_000;
  const f = fixture({
    now: () => now,
    publish: async () => {
      throw new Error("lost receipt");
    },
  });
  const dispatch = createFirstJobDispatcher(f.deps);
  await assert.rejects(dispatch(input), /lost receipt/);
  const before = [...f.calls];
  now += 6000;
  await assert.rejects(dispatch(input), /Check this thread/);
  assert.deepEqual(f.calls, before);
  assert.equal(f.read().message.id, outgoing.id);
});

test("a saved instruction that ages out during restart remains unsent and unchanged", async () => {
  let now = 1_000_000;
  let restarting = false;
  const f = fixture({
    now: () => now,
    startTeam: async () => {
      if (restarting) now += 6000;
    },
    publish: async () => {
      throw new Error("lost receipt");
    },
  });
  const dispatch = createFirstJobDispatcher(f.deps);
  await assert.rejects(dispatch(input), /lost receipt/);
  restarting = true;
  await assert.rejects(dispatch(input), /Check this thread/);
  assert.equal(f.read().message.id, outgoing.id);
  assert.equal(f.calls.filter((call) => call === "sign").length, 1);
});

test("lost send acknowledgment and relaunch reuse exactly one immutable signed instruction", async () => {
  let first = true;
  const published = [];
  const { deps, calls } = fixture({
    publish: async (_scope, value) => {
      published.push(JSON.stringify(value));
      if (first) {
        first = false;
        throw new Error("receipt lost");
      }
    },
  });
  await assert.rejects(createFirstJobDispatcher(deps)(input), /receipt lost/);
  await createFirstJobDispatcher(deps)(input);
  const afterRetry = calls.length;
  await createFirstJobDispatcher(deps)(input);
  assert.equal(calls.length, afterRetry);
  assert.equal(published.length, 2);
  assert.equal(published[0], published[1]);
  assert.equal(calls.filter((call) => call === "plan").length, 1);
  assert.equal(calls.filter((call) => call === "sign").length, 1);
});

test("two mounted controllers sharing a cross-window lock dispatch only once", async () => {
  const { deps, calls } = fixture();
  const [left, right] = await Promise.all([
    createFirstJobDispatcher(deps)(input),
    createFirstJobDispatcher(deps)(input),
  ]);
  assert.deepEqual(left, right);
  assert.equal(calls.filter((call) => call === "publish").length, 1);
  assert.equal(calls.filter((call) => call === "start").length, 1);
});

test("a different canonical winner cannot authorize this device's edited instruction", async () => {
  const { deps, calls } = fixture({
    resolveWork: async () => ({ ...work, actionId: "2".repeat(64) }),
  });
  await assert.rejects(
    createFirstJobDispatcher(deps)(input),
    /another window or device/,
  );
  assert.ok(!calls.includes("start"));
  assert.ok(!calls.includes("sign"));
  assert.ok(!calls.includes("publish"));
});

test("uncertain task attachment retries the same signed action before any runtime start", async () => {
  let first = true;
  const actions = [];
  const { deps, calls } = fixture({
    resolveWork: async (_scope, signed) => {
      actions.push(JSON.stringify(signed));
      if (first) {
        first = false;
        throw new Error("task receipt lost");
      }
      return work;
    },
  });
  await assert.rejects(
    createFirstJobDispatcher(deps)(input),
    /task receipt lost/,
  );
  assert.ok(!calls.includes("start"));
  await createFirstJobDispatcher(deps)(input);
  assert.deepEqual(actions, [JSON.stringify(action), JSON.stringify(action)]);
  assert.equal(calls.filter((call) => call === "plan").length, 1);
});

test("native start failure retains the same task and visibly rejects editing its saved attempt", async () => {
  const { deps, calls } = fixture({
    startTeam: async () => {
      throw new Error("native start failed");
    },
  });
  await assert.rejects(
    createFirstJobDispatcher(deps)(input),
    /native start failed/,
  );
  await assert.rejects(
    createFirstJobDispatcher(deps)({ ...input, content: "different work" }),
    /previous Start/,
  );
  assert.ok(!calls.includes("sign"));
  assert.ok(!calls.includes("publish"));
});

test("retry after a startup failure revalidates the current task before another runtime start", async () => {
  let cancelled = false;
  let starts = 0;
  const f = fixture({
    validateWork: async () => {
      if (cancelled) throw new Error("canonical task cancelled");
    },
    startTeam: async () => {
      starts += 1;
      if (starts === 1) throw new Error("native start failed");
    },
  });
  const dispatch = createFirstJobDispatcher(f.deps);
  await assert.rejects(dispatch(input), /native start failed/);
  cancelled = true;
  await assert.rejects(dispatch(input), /canonical task cancelled/);
  assert.equal(starts, 1);
  assert.equal(f.effects.size, 0);
  assert.equal(f.read().message, null);
  assert.equal(f.calls.filter((call) => call === "task").length, 1);
});

test("a task reassigned during readiness cannot receive the original team's instruction", async () => {
  let reassigned = false;
  const f = fixture({
    validateWork: async () => {
      if (reassigned) throw new Error("canonical task reassigned");
    },
    startTeam: async () => {
      reassigned = true;
    },
  });
  await assert.rejects(
    createFirstJobDispatcher(f.deps)(input),
    /canonical task reassigned/,
  );
  assert.equal(f.effects.size, 0);
  assert.equal(f.read().message, null);
});

test("an acknowledged instruction stays a read-only receipt after its task completes", async () => {
  let terminal = false;
  let validations = 0;
  const f = fixture({
    validateWork: async () => {
      validations += 1;
      if (terminal) throw new Error("canonical task completed");
    },
  });
  const dispatch = createFirstJobDispatcher(f.deps);
  const initial = await dispatch(input);
  const before = validations;
  terminal = true;
  assert.deepEqual(await dispatch(input), initial);
  assert.equal(validations, before);
  assert.equal(f.calls.filter((call) => call === "start").length, 1);
});

test("identity change after planning stops before publishing a task or launching agents", async () => {
  let active = true;
  const { deps, calls } = fixture({
    assertCurrent: async () => {
      if (!active) throw new Error("account changed");
    },
    plan: async () => {
      active = false;
      return action;
    },
  });
  await assert.rejects(
    createFirstJobDispatcher(deps)(input),
    /account changed/,
  );
  assert.deepEqual(calls, ["save:attempt"]);
});

test("storage refusal before action publication preserves zero external effects", async () => {
  const { deps, calls } = fixture({
    write: (_scope, attempt) => {
      if (attempt.action) throw new Error("storage full");
    },
  });
  await assert.rejects(createFirstJobDispatcher(deps)(input), /storage full/);
  assert.deepEqual(calls, ["plan"]);
});

test("storage failure after accepted send leaves exact signed message available for retry", async () => {
  const { deps, calls } = fixture();
  const write = deps.write;
  let fail = true;
  deps.write = (savedScope, attempt) => {
    if (attempt.acknowledged && fail) {
      fail = false;
      throw new Error("ack storage full");
    }
    write(savedScope, attempt);
  };
  await assert.rejects(
    createFirstJobDispatcher(deps)(input),
    /ack storage full/,
  );
  await createFirstJobDispatcher(deps)(input);
  assert.equal(calls.filter((call) => call === "publish").length, 2);
  assert.equal(calls.filter((call) => call === "sign").length, 1);
});
