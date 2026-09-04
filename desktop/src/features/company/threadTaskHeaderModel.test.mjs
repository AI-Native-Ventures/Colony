import assert from "node:assert/strict";
import { test } from "node:test";

import { threadTaskHeader } from "./threadTaskHeaderModel.ts";

function task(overrides = {}) {
  return {
    id: "thread-task:one",
    title: "Cut the release video",
    status: "inProgress",
    hidden: false,
    ...overrides,
  };
}

test("the header names the work the thread has open", () => {
  assert.deepEqual(threadTaskHeader(task(), "owner"), {
    title: "Cut the release video",
    canMarkDone: true,
  });
});

// A Company Action may only be signed by the human owner, so offering this
// to somebody the relay will refuse is offering a button that cannot work.
test("a member known not to be the owner is not offered the close", () => {
  assert.equal(threadTaskHeader(task(), "admin").canMarkDone, false);
  assert.equal(threadTaskHeader(task(), "member").canMarkDone, false);
});

// A relay that does not advertise NIP-43 membership reports no role for
// anybody, which is the ordinary single-owner install. Hiding the control
// there would take it away from the only person who could use it.
test("an unknown role is not a refusal", () => {
  assert.equal(threadTaskHeader(task(), undefined).canMarkDone, true);
  assert.equal(threadTaskHeader(task(), null).canMarkDone, true);
});

test("a thread with no open task offers nothing", () => {
  assert.deepEqual(threadTaskHeader(null, "owner"), {
    title: null,
    canMarkDone: false,
  });
});

// The hidden task carries the cost of turns that were not work. There is
// nothing in it for a member to finish, and naming it in the header would
// put the greeting it exists for back in front of them.
test("the hidden chat task is never named or closable", () => {
  assert.deepEqual(threadTaskHeader(task({ hidden: true }), "owner"), {
    title: null,
    canMarkDone: false,
  });
});
