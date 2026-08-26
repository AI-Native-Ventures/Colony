import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveTaskExecutionState,
  extractCanonicalTaskId,
  splitDeliveryArtifacts,
  splitThreadTasks,
} from "./taskThreadModel.ts";

const HEX = "a".repeat(64);

function task(overrides = {}) {
  return {
    id: "company:task",
    status: "inProgress",
    updatedAt: 1_800_000_000,
    ...overrides,
  };
}

test("splits a thread's history into live tasks and earlier ones", () => {
  const ordered = [
    task({ id: "t:run", status: "snoozed" }),
    task({ id: "t:pack", status: "inProgress" }),
    task({ id: "t:build", status: "completed" }),
    task({ id: "t:else", status: "cancelled" }),
  ];
  const { live, earlier } = splitThreadTasks(ordered);
  assert.deepEqual(
    live.map((entry) => entry.id),
    ["t:run", "t:pack"],
  );
  assert.deepEqual(
    earlier.map((entry) => entry.id),
    ["t:build", "t:else"],
  );
});

test("a thread with no history has neither live nor earlier tasks", () => {
  assert.deepEqual(splitThreadTasks([]), { live: [], earlier: [] });
});

test("extracts exactly one non-empty task association", () => {
  assert.equal(
    extractCanonicalTaskId([["task", "company:task"]]),
    "company:task",
  );
  assert.equal(extractCanonicalTaskId([]), null);
  assert.equal(
    extractCanonicalTaskId([
      ["task", "one"],
      ["task", "two"],
    ]),
    null,
  );
  assert.equal(extractCanonicalTaskId([["task", ""]]), null);
});

test("derives waiting, active, expiry recovery, resume, and terminal truth", () => {
  assert.equal(deriveTaskExecutionState(null, 100).key, "untracked");
  assert.equal(
    deriveTaskExecutionState({ runStatus: "queued" }, 100).key,
    "waiting",
  );
  assert.equal(
    deriveTaskExecutionState(
      { runStatus: "executing", leaseExpiresAt: 101 },
      100,
    ).key,
    "executing",
  );
  assert.equal(
    deriveTaskExecutionState(
      { runStatus: "executing", leaseExpiresAt: 100 },
      100,
    ).key,
    "recovery-pending",
  );
  assert.equal(
    deriveTaskExecutionState({ runStatus: "recoverable" }, 100).key,
    "ready-to-resume",
  );
  assert.equal(
    deriveTaskExecutionState({ runStatus: "delivered" }, 100).key,
    "delivered",
  );
  assert.equal(
    deriveTaskExecutionState({ runStatus: "failed" }, 100).key,
    "failed",
  );
  assert.equal(
    deriveTaskExecutionState({ runStatus: "abandoned" }, 100).key,
    "stopped",
  );
});

test("only accepted delivered evidence becomes primary and supporting", () => {
  const artifacts = [
    { kind: "event", reference: HEX, label: "Memo" },
    { kind: "url", reference: "https://example.com", label: null },
  ];
  assert.deepEqual(
    splitDeliveryArtifacts({ runStatus: "executing", artifacts }),
    {
      primary: null,
      supporting: [],
    },
  );
  assert.deepEqual(
    splitDeliveryArtifacts({ runStatus: "delivered", artifacts }),
    {
      primary: artifacts[0],
      supporting: [artifacts[1]],
    },
  );
});
