import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgentTitleApplier } from "./applyAgentTaskTitle.ts";

const RELAY = "a".repeat(64);
const RAW = "@Chief of Staff **find out about the latest openclaw changes**";
const INSTRUCTION =
  "@Chief of Staff find out about the latest openclaw changes";

const TASK = {
  schema: "colony.task/v1",
  id: "chat:abc",
  implicit: true,
  title: RAW,
  status: "inProgress",
};

function applier(overrides = {}) {
  const calls = { sign: [], submit: [] };
  const deps = {
    relaySelf: async () => RELAY,
    fetchTaskHead: async () => ({ id: "head1", kind: 30181 }),
    sign: async (input) => {
      calls.sign.push(input);
      return "signed-action";
    },
    broker: {
      submit: async (action) => {
        calls.submit.push(action);
        return {
          status: "applied",
          receiptEventId: "r",
          headEventId: "h",
          target: "t",
        };
      },
    },
    ...overrides,
  };
  return { apply: createAgentTitleApplier(deps), calls };
}

test("an agent's summary becomes the task title", async () => {
  const { apply, calls } = applier();
  const outcome = await apply({
    task: TASK,
    instruction: INSTRUCTION,
    checkpointSummary: "Summarise recent OpenClaw releases",
  });
  assert.deepEqual(outcome, {
    status: "renamed",
    title: "Summarise recent OpenClaw releases",
  });
  assert.equal(calls.sign[0].title, "Summarise recent OpenClaw releases");
  assert.equal(calls.submit.length, 1);
});

test("nothing is signed when there is no rename to make", async () => {
  const { apply, calls } = applier();
  const outcome = await apply({
    task: TASK,
    instruction: INSTRUCTION,
    checkpointSummary: null,
  });
  assert.deepEqual(outcome, { status: "skipped" });
  assert.equal(calls.sign.length, 0);
  assert.equal(calls.submit.length, 0);
});

test("a hand-created task is never renamed", async () => {
  const { apply, calls } = applier();
  const outcome = await apply({
    task: { ...TASK, implicit: false, title: "Ship the pricing page" },
    instruction: "Ship the pricing page",
    checkpointSummary: "Rewrite the pricing copy",
  });
  assert.deepEqual(outcome, { status: "skipped" });
  assert.equal(calls.sign.length, 0);
});

test("a community with no relay identity does nothing rather than guessing", async () => {
  const { apply, calls } = applier({ relaySelf: async () => null });
  const outcome = await apply({
    task: TASK,
    instruction: INSTRUCTION,
    checkpointSummary: "Summarise releases",
  });
  assert.deepEqual(outcome, { status: "skipped" });
  assert.equal(calls.sign.length, 0);
});

test("a missing head is skipped, not signed against nothing", async () => {
  const { apply, calls } = applier({ fetchTaskHead: async () => null });
  const outcome = await apply({
    task: TASK,
    instruction: INSTRUCTION,
    checkpointSummary: "Summarise releases",
  });
  assert.deepEqual(outcome, { status: "skipped" });
  assert.equal(calls.sign.length, 0);
});

test("a conflict is skipped: the head moved and this title is stale", async () => {
  const { apply } = applier({
    broker: {
      submit: async () => ({
        status: "conflict",
        receiptEventId: "r",
        target: "t",
        message: "This record changed while the request was in flight.",
      }),
    },
  });
  const outcome = await apply({
    task: TASK,
    instruction: INSTRUCTION,
    checkpointSummary: "Summarise releases",
  });
  assert.deepEqual(outcome, { status: "skipped" });
});

test("a rejected action reports the relay's own message", async () => {
  const { apply } = applier({
    broker: {
      submit: async () => ({
        status: "rejected",
        receiptEventId: "r",
        target: "t",
        message: "The relay refused this company change.",
      }),
    },
  });
  const outcome = await apply({
    task: TASK,
    instruction: INSTRUCTION,
    checkpointSummary: "Summarise releases",
  });
  assert.deepEqual(outcome, {
    status: "failed",
    message: "The relay refused this company change.",
  });
});

test("a signing failure is reported rather than thrown at the caller", async () => {
  const { apply } = applier({
    sign: async () => {
      throw new Error("renaming a task requires the community owner");
    },
  });
  const outcome = await apply({
    task: TASK,
    instruction: INSTRUCTION,
    checkpointSummary: "Summarise releases",
  });
  assert.deepEqual(outcome, {
    status: "failed",
    message: "renaming a task requires the community owner",
  });
});
