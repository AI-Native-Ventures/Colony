import assert from "node:assert/strict";
import test from "node:test";

import { dispatchWebsiteStart } from "./websiteStartDispatch.ts";

const scope = {
  jobId: "job-1",
  taskId: "task-1",
  channel: "channel-1",
};

test("a start request for another job fails closed without submitting", async () => {
  let submitted = false;
  await assert.rejects(
    () =>
      dispatchWebsiteStart({ ...scope, taskId: "task-2" }, scope, async () => {
        submitted = true;
      }),
    /changed before the start request could be sent/,
  );
  assert.equal(submitted, false);
});

test("a relay failure reaches the brief instead of becoming success", async () => {
  const failure = new Error("relay refused begin-work");
  await assert.rejects(
    () =>
      dispatchWebsiteStart(scope, scope, async () => {
        throw failure;
      }),
    (error) => error === failure,
  );
});

test("a successful submission resolves only after the transport resolves", async () => {
  let settled = false;
  const result = dispatchWebsiteStart(scope, scope, async () => {
    await Promise.resolve();
    settled = true;
  });
  assert.equal(settled, false);
  await result;
  assert.equal(settled, true);
});
