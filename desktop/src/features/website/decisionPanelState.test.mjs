import assert from "node:assert/strict";
import test from "node:test";

import {
  beginDecisionDispatch,
  clearDecisionFailure,
  completeDecisionDispatch,
  confirmDecisionReceipt,
  createDecisionPanelState,
  decisionScopeKey,
  failDecisionDispatch,
  isDispatchCurrent,
  setDecisionNote,
  withDecisionScope,
} from "./decisionPanelState.ts";
import { isScopeCurrent } from "./scopedAsync.ts";

const OWNER = "a".repeat(64);
const OTHER = "b".repeat(64);

function request(overrides = {}) {
  return {
    kind: "approve",
    jobId: "job-1",
    taskId: "task-1",
    channel: "chan-1",
    revision: 1,
    manifestSha256: "c".repeat(64),
    actor: OWNER,
    ...overrides,
  };
}

const SCOPE_A = decisionScopeKey({
  channel: "chan-1",
  jobId: "job-1",
  taskId: "task-1",
  actor: OWNER,
});
const SCOPE_B = decisionScopeKey({
  channel: "chan-1",
  jobId: "job-2",
  taskId: "task-1",
  actor: OWNER,
});

test("the scope key covers channel, job, task, and actor", () => {
  assert.equal(
    SCOPE_A,
    decisionScopeKey({
      channel: "chan-1",
      jobId: "job-1",
      taskId: "task-1",
      actor: OWNER,
    }),
  );
  assert.notEqual(
    SCOPE_A,
    decisionScopeKey({
      channel: "chan-1",
      jobId: "job-1",
      taskId: "task-1",
      actor: OTHER,
    }),
  );
  assert.notEqual(SCOPE_A, SCOPE_B);
});

test("switching scope resets note, pending, failure, and receipt", () => {
  let state = createDecisionPanelState(SCOPE_A);
  state = setDecisionNote(state, "Draft feedback");
  state = beginDecisionDispatch(state, {
    request: request(),
    identityKey: "identity",
  });
  state = failDecisionDispatch(state, {
    message: "Network error",
    request: request(),
    conflict: false,
  });
  assert.equal(state.scopeKey, SCOPE_A);

  const switched = withDecisionScope(state, SCOPE_B);
  assert.equal(switched.scopeKey, SCOPE_B);
  assert.equal(switched.note, "");
  assert.equal(switched.pending, null);
  assert.equal(switched.failed, null);
  assert.equal(switched.receipt, null);

  assert.equal(
    withDecisionScope(state, SCOPE_A),
    state,
    "same-scope access keeps object identity",
  );
});

test("a stale async result is ignored after a scope switch", () => {
  const dispatchScope = SCOPE_A;
  const currentScope = SCOPE_B;
  assert.equal(isDispatchCurrent(dispatchScope, currentScope), false);
  assert.equal(isScopeCurrent(dispatchScope, currentScope), false);
  assert.equal(isDispatchCurrent(SCOPE_A, SCOPE_A), true);

  const switched = createDecisionPanelState(SCOPE_B);
  // The component guard drops the old result before it can call a transition.
  assert.equal(switched.pending, null);
  assert.equal(switched.failed, null);
});

test("dispatch lifecycle keeps the exact request for retry", () => {
  const exact = request({ note: "Please soften the headline." });
  let state = createDecisionPanelState(SCOPE_A);
  state = beginDecisionDispatch(state, {
    request: exact,
    identityKey: "identity-1",
  });
  assert.equal(state.pending.request, exact);
  state = confirmDecisionReceipt(state, { eventId: "event-1" });
  assert.equal(state.pending.request, exact, "receipt does not clear pending");
  assert.equal(state.receipt.eventId, "event-1");

  state = failDecisionDispatch(state, {
    message: "Network error",
    request: exact,
    conflict: false,
  });
  assert.equal(state.pending, null);
  assert.equal(state.failed.request, exact, "retry keeps the exact payload");
  assert.equal(state.receipt, null);

  state = clearDecisionFailure(state);
  assert.equal(state.failed, null);
});

test("confirming the record completes the dispatch and clears the note", () => {
  let state = createDecisionPanelState(SCOPE_A);
  state = setDecisionNote(state, "Feedback");
  state = beginDecisionDispatch(state, {
    request: request({ note: "Feedback" }),
    identityKey: "identity-1",
  });
  state = completeDecisionDispatch(state);
  assert.equal(state.note, "");
  assert.equal(state.pending, null);
  assert.equal(state.failed, null);
  assert.equal(state.receipt, null);
});

test("two simultaneous cards on different jobs stay independent", () => {
  let cardA = createDecisionPanelState(SCOPE_A);
  let cardB = createDecisionPanelState(SCOPE_B);
  cardA = setDecisionNote(cardA, "A note");
  cardB = setDecisionNote(cardB, "B note");
  assert.equal(cardA.note, "A note");
  assert.equal(cardB.note, "B note");
  cardA = beginDecisionDispatch(cardA, {
    request: request(),
    identityKey: "identity-a",
  });
  assert.equal(cardB.pending, null);
  const switchedAway = withDecisionScope(
    cardA,
    "chan-1\u0000job-3\u0000task-1\u0000" + OWNER,
  );
  assert.equal(switchedAway.pending, null);
  assert.equal(cardA.pending.request.jobId, "job-1");
});
