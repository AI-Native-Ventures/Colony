import assert from "node:assert/strict";
import test from "node:test";

import { applyReactionState, isDuplicateReactionError } from "./noteActions.ts";

const NOTE_ID = "n".repeat(64);

test("applyReactionState adds a current-user reaction", () => {
  const next = applyReactionState(undefined, NOTE_ID, true);
  assert.deepEqual(next.get(NOTE_ID), {
    count: 1,
    reactedByCurrentUser: true,
  });
});

test("applyReactionState removes a current-user reaction", () => {
  const current = new Map([
    [NOTE_ID, { count: 2, reactedByCurrentUser: true }],
  ]);
  const next = applyReactionState(current, NOTE_ID, false);
  assert.deepEqual(next.get(NOTE_ID), {
    count: 1,
    reactedByCurrentUser: false,
  });
});

test("applyReactionState keeps count stable for no-op transitions", () => {
  const current = new Map([
    [NOTE_ID, { count: 2, reactedByCurrentUser: false }],
  ]);
  const next = applyReactionState(current, NOTE_ID, false);
  assert.deepEqual(next.get(NOTE_ID), {
    count: 2,
    reactedByCurrentUser: false,
  });
});

test("applyReactionState never decrements below zero", () => {
  const next = applyReactionState(undefined, NOTE_ID, false);
  assert.deepEqual(next.get(NOTE_ID), {
    count: 0,
    reactedByCurrentUser: false,
  });
});

test("isDuplicateReactionError detects relay duplicate responses", () => {
  assert.equal(
    isDuplicateReactionError(
      new Error("relay rejected event: duplicate: reaction already exists"),
    ),
    true,
  );
});

test("isDuplicateReactionError covers both post-contract relay messages", () => {
  // Re-sending the very kind:7 event that already holds the slot.
  assert.equal(
    isDuplicateReactionError(
      new Error(
        "relay rejected event: duplicate: identical reaction already applied",
      ),
    ),
    true,
  );
  // A different kind:7 event holds it, the usual case when the user already
  // liked the note. The emoji is on the note either way, so this is not an
  // error to show.
  assert.equal(
    isDuplicateReactionError(
      new Error(
        "relay rejected event: conflict: superseded by original reaction abc123",
      ),
    ),
    true,
  );
  // A legacy reactions row with no linked kind:7 event. Before the contract
  // change all four cases produced the one matched string, so missing this is
  // the only way a re-like could newly surface an error toast.
  assert.equal(
    isDuplicateReactionError(
      new Error(
        "relay rejected event: conflict: an active reaction already exists for this emoji",
      ),
    ),
    true,
  );
});

test("isDuplicateReactionError rejects unrelated errors and non-errors", () => {
  assert.equal(isDuplicateReactionError(new Error("network failed")), false);
  assert.equal(
    isDuplicateReactionError("duplicate: reaction already exists"),
    false,
  );
});
