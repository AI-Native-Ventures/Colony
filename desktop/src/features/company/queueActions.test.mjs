import assert from "node:assert/strict";
import { test } from "node:test";

import { createQueueActioner } from "./queueActions.ts";

const RELAY = "a".repeat(64);
const TASK_ID = "horizonlabs:run-outreach";

function head(id, createdAt = 1_780_000_100) {
  return {
    id: `head${id}${createdAt}`.padEnd(64, "0").slice(0, 64),
    pubkey: RELAY,
    created_at: createdAt,
    kind: 30181,
    tags: [["d", id]],
    content: "{}",
    sig: "0".repeat(128),
  };
}

function baseDeps(overrides = {}) {
  const submitted = [];
  return {
    relaySelf: async () => RELAY,
    fetchTaskHead: async () => head(TASK_ID),
    signCompletion: async (input) => `signed:complete:${input.outcomeReason}`,
    signSnooze: async (input) => `signed:snooze:${input.wakeAt}`,
    signBounce: async (input) => `signed:bounce:${input.reason}`,
    broker: {
      submit: async (signedActionJson) => {
        submitted.push(signedActionJson);
        return {
          status: "applied",
          receiptEventId: "r",
          headEventId: "h",
          target: "t",
        };
      },
    },
    submitted,
    ...overrides,
  };
}

test("completing a task fetches the current head, signs, and publishes", async () => {
  const deps = baseDeps();
  const actioner = createQueueActioner(deps);
  const outcome = await actioner.completeTask(TASK_ID, "booked a meeting");
  assert.deepEqual(outcome, { status: "applied" });
  assert.deepEqual(deps.submitted, ["signed:complete:booked a meeting"]);
});

test("snoozing signs with the requested wake time and publishes", async () => {
  const deps = baseDeps();
  const actioner = createQueueActioner(deps);
  const outcome = await actioner.snoozeTask(TASK_ID, 1_800_000_000);
  assert.deepEqual(outcome, { status: "applied" });
  assert.deepEqual(deps.submitted, ["signed:snooze:1800000000"]);
});

test("bouncing signs against the upstream task's own head", async () => {
  const deps = baseDeps();
  const actioner = createQueueActioner(deps);
  const outcome = await actioner.bounceUpstreamTask(
    "horizonlabs:build-site",
    "wrong industry angle",
  );
  assert.deepEqual(outcome, { status: "applied" });
  assert.deepEqual(deps.submitted, ["signed:bounce:wrong industry angle"]);
});

test("a receipt that is not applied comes back blocked with a message", async () => {
  const deps = baseDeps({
    broker: {
      submit: async () => ({
        status: "conflict",
        receiptEventId: "r",
        target: "t",
        message: "the task moved under you",
      }),
    },
  });
  const actioner = createQueueActioner(deps);
  const outcome = await actioner.completeTask(TASK_ID, "done");
  assert.equal(outcome.status, "blocked");
  assert.match(outcome.message, /the task moved under you/);
  assert.match(outcome.message, /trying again is safe/i);
});

test("no relay identity refuses before any fetch or signing happens", async () => {
  let fetchCalled = false;
  const deps = baseDeps({
    relaySelf: async () => null,
    fetchTaskHead: async () => {
      fetchCalled = true;
      return head(TASK_ID);
    },
  });
  const actioner = createQueueActioner(deps);
  await assert.rejects(
    () => actioner.completeTask(TASK_ID, "done"),
    /no stable identity/,
  );
  assert.equal(fetchCalled, false);
});

test("a task that no longer resolves refuses before signing", async () => {
  const deps = baseDeps({ fetchTaskHead: async () => null });
  const actioner = createQueueActioner(deps);
  await assert.rejects(
    () => actioner.completeTask(TASK_ID, "done"),
    /no longer exists/,
  );
});
