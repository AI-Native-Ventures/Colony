import assert from "node:assert/strict";
import test from "node:test";

const { readAskState, askStatesFromEvents, describeAskExpiry } = await import(
  "./askState.ts"
);

const ASK_HEX = "a".repeat(64);
const RELAY_HEX = "b".repeat(64);
const IMPOSTOR_HEX = "c".repeat(64);
const NOW = 1_800_000_000;

function stateEvent(content, overrides = {}) {
  return {
    id: "state-1",
    kind: 30200,
    pubkey: RELAY_HEX,
    created_at: NOW,
    content: JSON.stringify(content),
    tags: [["d", ASK_HEX]],
    ...overrides,
  };
}

test("an open head carries the relay's deadline and expiry action", () => {
  const state = readAskState(
    stateEvent({
      status: "open",
      deadline_at: NOW + 3_600,
      on_expiry: "rearms",
    }),
    RELAY_HEX,
  );
  assert.ok(state);
  assert.equal(state.askId, ASK_HEX);
  assert.equal(state.status, "open");
  assert.equal(state.deadlineAt, NOW + 3_600);
  assert.equal(state.onExpiry, "rearms");
  assert.equal(state.rearmedAt, null);
});

test("a head signed by anyone but the relay is refused", () => {
  const forged = stateEvent(
    { status: "open", deadline_at: NOW + 60, on_expiry: "default_executes" },
    { pubkey: IMPOSTOR_HEX },
  );
  assert.equal(readAskState(forged, RELAY_HEX), null);
});

test("two d tags fail closed rather than describing whichever came first", () => {
  const event = stateEvent(
    { status: "open", deadline_at: NOW + 60, on_expiry: "rearms" },
    {
      tags: [
        ["d", ASK_HEX],
        ["d", "d".repeat(64)],
      ],
    },
  );
  assert.equal(readAskState(event, RELAY_HEX), null);
});

test("an unknown status is refused rather than partially trusted", () => {
  const event = stateEvent({ status: "sideways", deadline_at: NOW });
  assert.equal(readAskState(event, RELAY_HEX), null);
});

test("unknown content fields are ignored so newer relays still parse", () => {
  const state = readAskState(
    stateEvent({
      status: "open",
      deadline_at: NOW + 60,
      on_expiry: "rearms",
      some_future_field: { nested: true },
    }),
    RELAY_HEX,
  );
  assert.ok(state);
  assert.equal(state.onExpiry, "rearms");
});

test("the newer head wins when a replacement has not fully propagated", () => {
  const older = stateEvent(
    { status: "open", deadline_at: NOW + 60, on_expiry: "rearms" },
    { id: "old", created_at: NOW - 100 },
  );
  const newer = stateEvent(
    { status: "resolved" },
    { id: "new", created_at: NOW },
  );
  const states = askStatesFromEvents([newer, older], RELAY_HEX);
  assert.equal(states.get(ASK_HEX).status, "resolved");
});

test("a re-arming ask says plainly that nothing happens without an answer", () => {
  const state = readAskState(
    stateEvent({
      status: "open",
      deadline_at: NOW + 3_600,
      on_expiry: "rearms",
    }),
    RELAY_HEX,
  );
  const sentence = describeAskExpiry(state, NOW - 11 * 86_400, NOW);
  assert.match(sentence, /will not resolve on its own/);
  assert.match(sentence, /Waiting 11 days so far/);
});

test("a one-day wait is singular", () => {
  const state = readAskState(
    stateEvent({ status: "open", deadline_at: NOW + 60, on_expiry: "rearms" }),
    RELAY_HEX,
  );
  assert.match(
    describeAskExpiry(state, NOW - 86_400, NOW),
    /Waiting 1 day so far/,
  );
});

test("a stated default names the option and the time left", () => {
  const state = readAskState(
    stateEvent({
      status: "open",
      deadline_at: NOW + 2 * 3_600,
      on_expiry: "default_executes",
      default_option: "proceed",
    }),
    RELAY_HEX,
  );
  const sentence = describeAskExpiry(state, NOW - 60, NOW);
  assert.match(sentence, /Unanswered in 2h/);
  assert.match(sentence, /"proceed" applies automatically/);
});

test("a closed head describes nothing: there is no countdown left to run", () => {
  const state = readAskState(stateEvent({ status: "resolved" }), RELAY_HEX);
  assert.ok(state);
  assert.equal(describeAskExpiry(state, NOW - 60, NOW), null);
});
