import assert from "node:assert/strict";
import test from "node:test";

import {
  createRelayTaskAssignmentResolver,
  validateRelayTaskAssignment,
} from "./assignment.mjs";

const OWNER = "f".repeat(64);
const WORKER = "a".repeat(64);
const TASK_EVENT = "1".repeat(64);
const WEBSITE_EVENT = "2".repeat(64);
const THREAD = "c".repeat(64);
const JOB = "11111111-1111-4111-8111-111111111111";
const CHANNEL = "22222222-2222-4222-8222-222222222222";

function snapshot(overrides = {}) {
  return {
    relayUrl: "wss://relay.example.com",
    ownerPubkey: OWNER,
    workerPubkey: WORKER,
    workerPersonaId: "builtin:research",
    jobId: JOB,
    taskId: "thread-task:website",
    channelId: CHANNEL,
    threadRoot: THREAD,
    taskEventId: TASK_EVENT,
    websiteEventId: WEBSITE_EVENT,
    websiteGeneration: 3,
    task: {
      id: "thread-task:website",
      sourceChannelId: CHANNEL,
      threadRoot: THREAD,
      status: "inProgress",
      assigneePersonaIds: ["builtin:research"],
      qaPersonaId: "builtin:review",
    },
    website: {
      jobId: JOB,
      taskId: "thread-task:website",
      channel: CHANNEL,
      threadRoot: THREAD,
      owner: OWNER,
      status: "working",
      currentRevision: 4,
      revisions: [
        {
          revision: 4,
          preview: {
            url: "https://artifact.example.com/website-r4.json",
            sha256: "b".repeat(64),
          },
        },
      ],
    },
    ...overrides,
  };
}

const EXPECTED = {
  relayUrl: "wss://relay.example.com",
  ownerPubkey: OWNER,
  workerPubkey: WORKER,
  jobId: JOB,
  taskId: "thread-task:website",
  channelId: CHANNEL,
  threadRoot: THREAD,
};

test("native snapshot accepts an assigned worker and returns a stable fingerprint", () => {
  const authorization = validateRelayTaskAssignment(snapshot(), EXPECTED);
  assert.equal(authorization.authorized, true);
  assert.equal(authorization.workerPersonaId, "builtin:research");
  assert.equal(authorization.websiteRevision, 4);
  assert.equal(
    authorization.websiteManifestUrl,
    "https://artifact.example.com/website-r4.json",
  );
  assert.equal(authorization.websiteManifestSha256, "b".repeat(64));
  assert.equal(
    authorization.fingerprint,
    `${TASK_EVENT}:${WEBSITE_EVENT}:3:builtin:research`,
  );
});

test("a QA persona is accepted through the canonical qaPersonaId field", () => {
  const value = snapshot({
    workerPersonaId: "builtin:review",
    task: {
      ...snapshot().task,
      assigneePersonaIds: ["builtin:research"],
      qaPersonaId: "builtin:review",
    },
  });
  assert.equal(validateRelayTaskAssignment(value, EXPECTED).authorized, true);
});

test("an initial Working job may authorize public research before its first revision", () => {
  const authorization = validateRelayTaskAssignment(
    snapshot({
      website: { ...snapshot().website, currentRevision: 0 },
    }),
    EXPECTED,
  );
  assert.equal(authorization.authorized, true);
  assert.equal(authorization.websiteRevision, 0);
});

test("owner or coordinator metadata cannot substitute for task assignment", () => {
  assert.throws(
    () =>
      validateRelayTaskAssignment(
        snapshot({
          workerPersonaId: "builtin:coordinator",
          task: {
            ...snapshot().task,
            assigneePersonaIds: [],
            qaPersonaId: "builtin:review",
          },
        }),
        EXPECTED,
      ),
    /not assigned/,
  );
});

test("closed task, handed-over review, and changed coordinates revoke access", () => {
  for (const changed of [
    { task: { ...snapshot().task, status: "completed" } },
    { website: { ...snapshot().website, status: "handedOver" } },
    { website: { ...snapshot().website, threadRoot: "d".repeat(64) } },
    { websiteEventId: "A".repeat(64) },
  ]) {
    assert.throws(() => validateRelayTaskAssignment(snapshot(changed), EXPECTED));
  }
});

test("evidence follows the accepted task and active Website lifecycle phases", () => {
  for (const status of ["ready", "inProgress", "inReview"]) {
    assert.doesNotThrow(() =>
      validateRelayTaskAssignment(
        snapshot({ task: { ...snapshot().task, status } }),
        EXPECTED,
      ),
    );
  }
  for (const status of ["proposed", "blocked", "snoozed", "completed", "cancelled"]) {
    assert.throws(
      () =>
        validateRelayTaskAssignment(
          snapshot({ task: { ...snapshot().task, status } }),
          EXPECTED,
        ),
      /CompanyTask is not active/,
    );
  }
  for (const status of [
    "working",
    "readyForReview",
    "approved",
    "changesRequested",
  ]) {
    assert.doesNotThrow(() =>
      validateRelayTaskAssignment(
        snapshot({ website: { ...snapshot().website, status } }),
        EXPECTED,
      ),
    );
  }
  for (const status of ["draft", "handedOver"]) {
    assert.throws(
      () =>
        validateRelayTaskAssignment(
          snapshot({ website: { ...snapshot().website, status } }),
          EXPECTED,
        ),
      /Website job is not active/,
    );
  }
});

test("resolver passes only the exact coordinates to the native reader", async () => {
  let received;
  const resolve = createRelayTaskAssignmentResolver({
    read: async (request) => {
      received = request;
      return snapshot();
    },
  });
  const authorization = await resolve(EXPECTED);
  assert.equal(authorization.authorized, true);
  assert.deepEqual(received, EXPECTED);
});

test("resolver refuses a scope without task and channel coordinates", async () => {
  const resolve = createRelayTaskAssignmentResolver({ read: async () => snapshot() });
  await assert.rejects(
    () => resolve({ ...EXPECTED, taskId: undefined }),
    /task and channel coordinate/,
  );
});
