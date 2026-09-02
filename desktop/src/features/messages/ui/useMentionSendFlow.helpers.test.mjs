/**
 * Unit tests for getErrorMessage, the extraction helper that
 * createFinishSendFailureHandler (useMentionSendFlow.helpers.ts) uses to put
 * a failed attachOutgoingWorkContext call in front of the user via
 * toast.error, instead of the message silently disappearing.
 *
 * In useMentionSendFlow.ts, finishSend catches around the
 * attachOutgoingWorkContext call and calls this handler there so the attach
 * step's own message survives. A failure from send() itself (or anything
 * after it) reaches the two outer catch sites, which since 2026-09-02 report
 * through the same handler rather than restoring the draft in silence: see
 * useMentionSendFlow.sendFailure.test.mjs. They swallowed every send()
 * rejection before that, which is how a message the native command refused
 * came back as a restored draft and nothing else.
 *
 * What is NOT tested here (and why): mounting useMentionSendFlow itself to
 * assert that toast.error and restoreComposerAfterFailure are called from
 * the right site for each failure kind. That hook depends on Tiptap, Tauri,
 * relayClient, and React Query context not available in the node:test
 * harness (see MessageComposerAutoSend.test.mjs for the same constraint on
 * a sibling hook). This test instead proves the seam the attach-failure
 * handler relies on: that the specific, human-written error strings thrown
 * by attachWorkContext / workContext.ts survive extraction unchanged, so the
 * toast reads the real cause rather than a generic fallback.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  getErrorMessage,
  threadRootForWorkContext,
} from "./useMentionSendFlow.helpers.ts";

test("getErrorMessage_surfaces_the_thrown_work_context_message", () => {
  const error = new Error(
    "This community has no coordination team to own ambiguous work. The message has not been sent.",
  );
  assert.equal(
    getErrorMessage(error, "The message could not be sent."),
    "This community has no coordination team to own ambiguous work. The message has not been sent.",
  );
});

test("getErrorMessage_surfaces_the_no_receipt_message", () => {
  const error = new Error("The message has not been sent.");
  assert.equal(
    getErrorMessage(error, "The message could not be sent."),
    "The message has not been sent.",
  );
});

test("getErrorMessage_falls_back_for_a_non_error_throw", () => {
  assert.equal(
    getErrorMessage("boom", "The message could not be sent."),
    "The message could not be sent.",
  );
});

test("getErrorMessage_falls_back_for_an_error_with_an_empty_message", () => {
  assert.equal(
    getErrorMessage(new Error(""), "The message could not be sent."),
    "The message could not be sent.",
  );
});

const THREAD_HEAD = "5910f909".padEnd(64, "a");
const PARENT = "abcd1234".padEnd(64, "b");

/**
 * The Task names the thread's head, because the relay's row marker is
 * ["e", root, "", "root"]. Naming the immediate parent instead would scope a
 * deep reply's notice to a message in the middle of the thread rather than to
 * the thread itself.
 */
test("the work context names the thread head, not the immediate parent", () => {
  assert.equal(
    threadRootForWorkContext({
      parentEventId: PARENT,
      threadHeadId: THREAD_HEAD,
    }),
    THREAD_HEAD,
  );
});

test("a first reply falls back to its parent, which is the thread root", () => {
  assert.equal(
    threadRootForWorkContext({ parentEventId: PARENT, threadHeadId: null }),
    PARENT,
  );
});

test("a send at channel root names no thread", () => {
  assert.equal(threadRootForWorkContext(null), null);
  assert.equal(
    threadRootForWorkContext({ parentEventId: null, threadHeadId: null }),
    null,
  );
});
