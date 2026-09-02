/**
 * A failed send has to be visible.
 *
 * `completeSend` ran `finishSend` inside a bare `catch` that only restored the
 * draft, on the stated assumption that anything reaching it had already been
 * toasted by the attach step. That assumption is false: the attach step
 * catches its own failure and `return`s, so the only errors that ever reach
 * that catch are `send()`'s, and none of them were reported. The observed
 * symptom was the whole bug: the draft came back, no message posted, no toast.
 *
 * Both outer catch sites now go through `runReportingFinishSendFailures`,
 * which is the seam these tests drive. `sonner` is mocked at module scope (a
 * dynamic import is cached, so a per-test mock would never reach the
 * already-loaded helpers) so the assertion is on the toast a user would read.
 */
import assert from "node:assert/strict";
import test, { beforeEach, mock } from "node:test";

/** Every message passed to `toast.error`, in order. */
const toasts = [];

mock.module("sonner", {
  namedExports: {
    toast: {
      error: (message) => toasts.push(message),
      success: () => {},
    },
  },
});

const { createFinishSendFailureHandler, runReportingFinishSendFailures } =
  await import("./useMentionSendFlow.helpers.ts");

const restored = [];

beforeEach(() => {
  toasts.length = 0;
  restored.length = 0;
});

const handleFinishSendFailure = () =>
  createFinishSendFailureHandler(() => restored.push("restored"));

test("a rejected finishSend is toasted and the draft is restored", async () => {
  await runReportingFinishSendFailures(async () => {
    throw new Error("media tags must use 'imeta' prefix (got Some(\"task\"))");
  }, handleFinishSendFailure());

  assert.deepEqual(toasts, [
    "media tags must use 'imeta' prefix (got Some(\"task\"))",
  ]);
  assert.deepEqual(restored, ["restored"]);
});

test("a rejected finishSend does not propagate out of completeSend", async () => {
  await assert.doesNotReject(() =>
    runReportingFinishSendFailures(async () => {
      throw new Error("boom");
    }, handleFinishSendFailure()),
  );
  assert.deepEqual(restored, ["restored"]);
});

test("a successful finishSend reports nothing", async () => {
  await runReportingFinishSendFailures(
    async () => {},
    handleFinishSendFailure(),
  );

  assert.deepEqual(toasts, []);
  assert.deepEqual(restored, []);
});
