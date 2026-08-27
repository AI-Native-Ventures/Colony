import assert from "node:assert/strict";
import test from "node:test";

import {
  ASK_DEADLINE_WARNING_SECS,
  askArrivalDedupeKeys,
  askNotificationSignals,
  mergeAskNotificationKeys,
} from "./askNotificationSignals.ts";

const NOW_MS = 1_700_000_000_000;
const NOW_SECS = 1_700_000_000;

function ask(id, overrides = {}) {
  return {
    id,
    askType: "decision",
    headline: `Headline ${id}`,
    costOfDelay: null,
    filerPubkey: "f".repeat(64),
    createdAt: NOW_SECS - 60,
    rawContent: "{}",
    channelId: null,
    threadId: null,
    audiencePubkey: "0".repeat(64),
    priorAskId: null,
    originalFilerPubkey: null,
    ...overrides,
  };
}

function openState(askId, deadlineAt) {
  return {
    askId,
    status: "open",
    deadlineAt,
    onExpiry: "rearms",
    defaultOption: null,
    promotesTo: null,
    rearmedAt: null,
    closedAt: null,
    defaultExecuted: false,
    successorAskId: null,
  };
}

function run({ asks, states = new Map(), delivered = [] }) {
  return askNotificationSignals({
    asks,
    states,
    nowMs: NOW_MS,
    delivered: new Set(delivered),
  });
}

test("a new ask addressed to you notifies once", () => {
  const signals = run({ asks: [ask("one")] });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "arrived");
  assert.equal(signals[0].key, "arrived:one");
  assert.equal(signals[0].title, "An agent needs a decision");
  assert.equal(signals[0].body, "Headline one");
});

test("the arrival title names the ask type, not just 'a decision'", () => {
  const titleFor = (askType) =>
    run({ asks: [ask("one", { askType })] })[0].title;
  assert.equal(titleFor("question"), "An agent has a question");
  assert.equal(titleFor("credential"), "An agent needs a credential");
  assert.equal(titleFor("blocker"), "An agent is blocked on you");
  assert.equal(titleFor("stall"), "A task has gone silent");
  assert.equal(titleFor("something-new"), "An agent needs you");
});

test("a promoted ask is announced as a promotion, not an arrival", () => {
  const signals = run({
    asks: [ask("two", { priorAskId: "p".repeat(64) })],
  });
  assert.equal(signals[0].kind, "promoted");
  assert.equal(signals[0].key, "promoted:two");
  assert.equal(signals[0].title, "Ask promoted to you");
});

test("the same ask never notifies twice", () => {
  assert.deepEqual(run({ asks: [ask("one")], delivered: ["arrived:one"] }), []);
});

test("an answered or withdrawn ask cannot signal, because it is not in the open set", () => {
  // `useOpenAsks` subtracts every ask named by a 44301 or 44302, so a closed
  // ask never reaches this function at all.
  assert.deepEqual(run({ asks: [] }), []);
});

test("an approaching deadline notifies after the arrival was already announced", () => {
  const signals = run({
    asks: [ask("one")],
    states: new Map([["one", openState("one", NOW_SECS + 600)]]),
    delivered: ["arrived:one"],
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "deadline");
  assert.equal(signals[0].key, "deadline:one");
  assert.equal(signals[0].title, "Ask due in 10 minutes");
});

test("only one signal per ask per pass: an arrival inside the window does not double up", () => {
  const signals = run({
    asks: [ask("one")],
    states: new Map([["one", openState("one", NOW_SECS + 600)]]),
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "arrived");
});

test("a deadline warning never repeats", () => {
  assert.deepEqual(
    run({
      asks: [ask("one")],
      states: new Map([["one", openState("one", NOW_SECS + 600)]]),
      delivered: ["arrived:one", "deadline:one"],
    }),
    [],
  );
});

test("a deadline outside the warning window is silent", () => {
  assert.deepEqual(
    run({
      asks: [ask("one")],
      states: new Map([
        ["one", openState("one", NOW_SECS + ASK_DEADLINE_WARNING_SECS + 1)],
      ]),
      delivered: ["arrived:one"],
    }),
    [],
  );
});

test("an already-passed deadline is not 'approaching'", () => {
  assert.deepEqual(
    run({
      asks: [ask("one")],
      states: new Map([["one", openState("one", NOW_SECS - 1)]]),
      delivered: ["arrived:one"],
    }),
    [],
  );
});

test("a head that already closed stops the countdown warning", () => {
  const closed = { ...openState("one", NOW_SECS + 60), status: "resolved" };
  assert.deepEqual(
    run({
      asks: [ask("one")],
      states: new Map([["one", closed]]),
      delivered: ["arrived:one"],
    }),
    [],
  );
});

test("an ask with no readable head still arrives, it just never warns", () => {
  assert.equal(run({ asks: [ask("one")] }).length, 1);
  assert.deepEqual(run({ asks: [ask("one")], delivered: ["arrived:one"] }), []);
});

// --- dedupe set -------------------------------------------------------------

test("the first-run seed covers arrivals and promotions, never deadlines", () => {
  const keys = askArrivalDedupeKeys([
    ask("one"),
    ask("two", { priorAskId: "p".repeat(64) }),
  ]);
  assert.deepEqual(keys, ["arrived:one", "promoted:two"]);
  assert.equal(
    keys.some((key) => key.startsWith("deadline:")),
    false,
  );
});

test("merging is idempotent and returns the same array when nothing is new", () => {
  const current = ["arrived:one"];
  assert.equal(mergeAskNotificationKeys(current, ["arrived:one"]), current);
  assert.deepEqual(mergeAskNotificationKeys(current, ["deadline:one"]), [
    "arrived:one",
    "deadline:one",
  ]);
});

test("the dedupe set evicts oldest-first past its cap", () => {
  const merged = mergeAskNotificationKeys(["a", "b", "c"], ["d"], 2);
  assert.deepEqual(merged, ["c", "d"]);
});
