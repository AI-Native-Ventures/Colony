import assert from "node:assert/strict";
import test from "node:test";

import {
  awaitBriefConfirmation,
  beginBriefStart,
  briefScopeKey,
  createBriefStartState,
  failBriefStart,
} from "./briefState.ts";

const REQUEST = { jobId: "job-1", taskId: "task-1", channel: "chan-1" };

test("the brief scope key covers the start idempotency fields", () => {
  assert.equal(briefScopeKey(REQUEST), briefScopeKey({ ...REQUEST }));
  assert.notEqual(
    briefScopeKey(REQUEST),
    briefScopeKey({ ...REQUEST, jobId: "job-2" }),
  );
  assert.notEqual(
    briefScopeKey(REQUEST),
    briefScopeKey({ ...REQUEST, channel: "chan-2" }),
  );
});

test("the start lifecycle moves idle to starting to waiting", () => {
  assert.deepEqual(createBriefStartState(), { status: "idle" });
  assert.deepEqual(beginBriefStart(), { status: "starting" });
  assert.deepEqual(awaitBriefConfirmation(), { status: "waiting" });
});

test("a failure keeps its message for the retry path", () => {
  const failed = failBriefStart("The relay rejected the start.");
  assert.deepEqual(failed, {
    status: "failed",
    message: "The relay rejected the start.",
  });
});

test("a switched job starts from a fresh idle state", () => {
  const first = beginBriefStart();
  const second = createBriefStartState();
  assert.equal(first.status, "starting");
  assert.equal(second.status, "idle");
  assert.notEqual(briefScopeKey(REQUEST), briefScopeKey({ ...REQUEST, jobId: "job-2" }));
});
