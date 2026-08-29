/**
 * Unit tests for getErrorMessage, the extraction helper that
 * finishSend's failure handler (useMentionSendFlow.ts, handleFinishSendFailure)
 * uses to put the underlying work-context error in front of the user via
 * toast.error, instead of the message silently disappearing.
 *
 * What is NOT tested here (and why): mounting useMentionSendFlow itself to
 * assert that toast.error and restoreComposerAfterFailure are both called
 * from the two finishSend catch sites. That hook depends on Tiptap, Tauri,
 * relayClient, and React Query context not available in the node:test
 * harness (see MessageComposerAutoSend.test.mjs for the same constraint on
 * a sibling hook). This test instead proves the seam both catch sites
 * actually rely on: that the specific, human-written error strings thrown by
 * attachWorkContext / workContext.ts survive extraction unchanged, so the
 * toast reads the real cause rather than a generic fallback.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { getErrorMessage } from "./useMentionSendFlow.helpers.ts";

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
