import assert from "node:assert/strict";
import { test } from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import {
  collapseAndSelectCurrentTaskRun,
  collapseAndSelectCurrentTaskRuns,
  parseTaskRunHead,
} from "./taskRunContracts.ts";

const SECRET = generateSecretKey();
const JOB = "a".repeat(64);
const EMPLOYEE = getPublicKey(SECRET);
const ORIGINATOR = "c".repeat(64);
const FILER = "d".repeat(64);
const HOLDER = "e".repeat(64);
const THREAD = "f".repeat(64);
const CHECKPOINT_EVENT = "1".repeat(64);
const OUTCOME_EVENT = "2".repeat(64);
const TASK = "company:task-one";
const CHANNEL = "engineering";

function jobHead({
  artifacts,
  attempts = 0,
  checkpoint,
  checkpointEvent,
  checkpointSequence,
  createdAt = 1_800_000_000,
  jobId = JOB,
  leaseExpires,
  outcomeEvent,
  runStatus = "queued",
  status = "open",
  taskId = TASK,
  secret = SECRET,
} = {}) {
  const tags = [
    ["d", jobId],
    ["employee", EMPLOYEE],
    ["originator", ORIGINATOR],
    ["filed-by", FILER],
    ["status", status],
    ["attempts", String(attempts)],
    ["p", ORIGINATOR],
    ["h", CHANNEL],
    ["e", THREAD],
    ["task", taskId],
    ["run-status", runStatus],
  ];
  if (leaseExpires !== undefined) {
    tags.push(
      ["lease-holder", HOLDER],
      ["lease-expires", String(leaseExpires)],
    );
  }
  if (checkpointSequence !== undefined)
    tags.push(["checkpoint-seq", String(checkpointSequence)]);
  if (checkpointEvent) tags.push(["checkpoint-event", checkpointEvent]);
  if (outcomeEvent) tags.push(["outcome-event", outcomeEvent]);
  return finalizeEvent(
    {
      kind: 30191,
      created_at: createdAt,
      tags,
      content: JSON.stringify({
        instruction: "Deliver the reviewed launch memo",
        ...(checkpoint ? { checkpoint } : {}),
        ...(artifacts ? { artifacts } : {}),
      }),
    },
    secret,
  );
}

test("selects current runs for multiple task contexts in one bounded pass", () => {
  const secondTask = "company:task-two";
  const secondChannel = "product";
  const secondThread = "a".repeat(64);
  const selected = collapseAndSelectCurrentTaskRuns(
    [
      jobHead(),
      jobHead({
        jobId: "b".repeat(64),
        taskId: secondTask,
        createdAt: 1_800_000_001,
      }),
      jobHead({
        jobId: "c".repeat(64),
        taskId: "unrelated-task",
        createdAt: 1_800_000_002,
      }),
    ],
    [
      { taskId: TASK, channelId: CHANNEL, threadId: THREAD },
      {
        taskId: secondTask,
        channelId: CHANNEL,
        threadId: THREAD,
      },
    ],
  );

  assert.equal(selected.get(TASK)?.jobId, JOB);
  assert.equal(selected.get(secondTask)?.jobId, "b".repeat(64));
  assert.equal(selected.has("unrelated-task"), false);

  // A context mismatch must not make a valid head appear under another task.
  const mismatched = collapseAndSelectCurrentTaskRuns(
    [jobHead({ taskId: secondTask })],
    [{ taskId: secondTask, channelId: secondChannel, threadId: secondThread }],
  );
  assert.equal(mismatched.get(secondTask), null);
});

test("parses an accepted checkpoint and preserves only public recovery fields", () => {
  const parsed = parseTaskRunHead(
    jobHead({
      attempts: 1,
      status: "leased",
      runStatus: "executing",
      leaseExpires: 1_800_000_100,
      checkpointSequence: 3,
      checkpointEvent: CHECKPOINT_EVENT,
      checkpoint: {
        summary: "Draft complete; reviewer pass is next.",
        resumeToken: "opaque-not-for-display",
        progress: 70,
      },
    }),
    { taskId: TASK, channelId: CHANNEL, threadId: THREAD },
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.checkpoint.sequence, 3);
  assert.equal(
    parsed.value.checkpoint.summary,
    "Draft complete; reviewer pass is next.",
  );
  assert.equal(parsed.value.checkpoint.progress, 70);
  assert.equal(parsed.value.checkpoint.eventId, CHECKPOINT_EVENT);
  assert.equal("resumeToken" in parsed.value.checkpoint, false);
});

test("delivered heads require an outcome receipt and at least one valid artifact", () => {
  const missing = parseTaskRunHead(
    jobHead({ attempts: 1, status: "done", runStatus: "delivered" }),
    { taskId: TASK, channelId: CHANNEL, threadId: THREAD },
  );
  assert.equal(missing.ok, false);

  const parsed = parseTaskRunHead(
    jobHead({
      attempts: 1,
      status: "done",
      runStatus: "delivered",
      outcomeEvent: OUTCOME_EVENT,
      artifacts: [
        { kind: "text", ref: "# Launch memo\nApproved.", label: "Launch memo" },
        { kind: "url", ref: "https://example.com/proof", label: null },
      ],
    }),
    { taskId: TASK, channelId: CHANNEL, threadId: THREAD },
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.artifacts.length, 2);
  assert.equal(parsed.value.outcomeEventId, OUTCOME_EVENT);
});

test("refuses cross-context, duplicate singleton, and inconsistent run states", () => {
  for (const event of [
    jobHead({ taskId: "company:other" }),
    { ...jobHead(), tags: [...jobHead().tags, ["task", TASK]] },
    jobHead({ status: "open", attempts: 1, runStatus: "queued" }),
  ]) {
    assert.equal(
      parseTaskRunHead(event, {
        taskId: TASK,
        channelId: CHANNEL,
        threadId: THREAD,
      }).ok,
      false,
    );
  }
});

test("refuses a valid signature when the signer is not the assigned employee", () => {
  const parsed = parseTaskRunHead(jobHead({ secret: generateSecretKey() }), {
    taskId: TASK,
    channelId: CHANNEL,
    threadId: THREAD,
  });
  assert.equal(parsed.ok, false);
});

test("collapses each d coordinate then selects the newest current head", () => {
  const olderReplacement = jobHead({ createdAt: 10 });
  const newerReplacement = jobHead({
    createdAt: 20,
    attempts: 1,
    status: "open",
    runStatus: "recoverable",
  });
  const otherJob = jobHead({
    createdAt: 15,
    jobId: "9".repeat(64),
  });
  const selected = collapseAndSelectCurrentTaskRun(
    [olderReplacement, otherJob, newerReplacement],
    { taskId: TASK, channelId: CHANNEL, threadId: THREAD },
  );
  assert.equal(selected?.eventId, newerReplacement.id);
  assert.equal(selected?.runStatus, "recoverable");
});
