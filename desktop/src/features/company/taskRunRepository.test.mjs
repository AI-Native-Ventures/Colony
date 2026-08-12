import assert from "node:assert/strict";
import { test } from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  createTaskRunRepository,
  resetTaskRunRepositoryState,
} from "./taskRunRepository.ts";

const SECRET = generateSecretKey();
const JOB = "a".repeat(64);
const PERSON = getPublicKey(SECRET);
const THREAD = "c".repeat(64);

function head({
  channel = "engineering",
  task = "company:task",
  thread = THREAD,
} = {}) {
  return finalizeEvent(
    {
      kind: 30191,
      created_at: 100,
      tags: [
        ["d", JOB],
        ["employee", PERSON],
        ["originator", PERSON],
        ["filed-by", PERSON],
        ["status", "open"],
        ["attempts", "0"],
        ["p", PERSON],
        ["h", channel],
        ["e", thread],
        ["task", task],
        ["run-status", "queued"],
      ],
      content: JSON.stringify({ instruction: "Deliver the memo" }),
    },
    SECRET,
  );
}

test("queries one exact task/channel/thread scope with an explicit kind", async () => {
  let seen;
  const repository = createTaskRunRepository({
    fetchEvents: async (filter) => {
      seen = filter;
      return [head()];
    },
  });
  const result = await repository.getCurrentRun({
    taskId: "company:task",
    channelId: "engineering",
    threadId: THREAD,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value?.runStatus, "queued");
  assert.deepEqual(seen, {
    kinds: [30191],
    "#task": ["company:task"],
    "#h": ["engineering"],
    "#e": [THREAD],
    limit: 100,
  });
});

test("drops forged scope matches instead of leaking another thread", async () => {
  const repository = createTaskRunRepository({
    fetchEvents: async () => [
      head({ task: "company:other" }),
      head({ channel: "sales" }),
      head({ thread: "d".repeat(64) }),
    ],
  });
  const result = await repository.getCurrentRun({
    taskId: "company:task",
    channelId: "engineering",
    threadId: THREAD,
  });
  assert.deepEqual(result, { ok: true, value: null });
});

test("cancels an in-flight read when the community changes", async () => {
  let release;
  const repository = createTaskRunRepository({
    fetchEvents: () => new Promise((resolve) => (release = resolve)),
  });
  const pending = repository.getCurrentRun({
    taskId: "company:task",
    channelId: "engineering",
    threadId: THREAD,
  });
  resetTaskRunRepositoryState();
  release([head()]);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, "cancelled");
});

test("reports relay failure without manufacturing a state", async () => {
  const repository = createTaskRunRepository({
    fetchEvents: async () => {
      throw new Error("offline");
    },
  });
  const result = await repository.getCurrentRun({
    taskId: "company:task",
    channelId: "engineering",
    threadId: THREAD,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "unavailable");
});
