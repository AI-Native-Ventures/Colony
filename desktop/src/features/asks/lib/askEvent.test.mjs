import assert from "node:assert/strict";
import test from "node:test";

import { askStatesFromEvents } from "./askState.ts";

const { readAsk, selectOpenAsks } = await import("./askEvent.ts");

const askEvent = (id, content) => ({
  id,
  kind: 44300,
  pubkey: "filer-pubkey",
  created_at: 1000,
  content: JSON.stringify(content),
  tags: [],
});

test("a well-formed ask reads its fields", () => {
  const event = askEvent("ask-1", {
    type: "decision",
    headline: "Which vendor for SMS?",
    cost_of_delay: "onboarding is blocked",
  });
  const ask = readAsk(event);
  assert.equal(ask.id, "ask-1");
  assert.equal(ask.askType, "decision");
  assert.equal(ask.headline, "Which vendor for SMS?");
  assert.equal(ask.costOfDelay, "onboarding is blocked");
  assert.equal(ask.filerPubkey, "filer-pubkey");
  assert.equal(ask.rawContent, event.content);
});

test("the ask type comes off the `ask-type` tag, where NIP-IQ puts it", () => {
  const ask = readAsk({
    ...askEvent("ask-typed", { headline: "Ship it?" }),
    tags: [["ask-type", "credential"]],
  });
  assert.equal(ask.askType, "credential");
});

test("a value outside the pinned ask-type vocabulary falls back rather than rendering junk", () => {
  const ask = readAsk({
    ...askEvent("ask-weird", { headline: "Ship it?" }),
    tags: [["ask-type", "urgent"]],
  });
  assert.equal(ask.askType, "question");
});

test("a duplicate ask-type tag fails closed, as the relay's parser does", () => {
  const ask = readAsk({
    ...askEvent("ask-dupe", { headline: "Ship it?" }),
    tags: [
      ["ask-type", "blocker"],
      ["ask-type", "decision"],
    ],
  });
  assert.equal(ask.askType, "question");
});

test("an ask keeps optional channel and thread source tags", () => {
  const ask = readAsk({
    ...askEvent("ask-source", { type: "question", headline: "Need context" }),
    tags: [
      ["h", "channel-1"],
      ["e", "thread-1", "", "root"],
    ],
  });
  assert.equal(ask.channelId, "channel-1");
  assert.equal(ask.threadId, "thread-1");
});

test("an ask with no source tags remains channel-less", () => {
  const ask = readAsk(askEvent("ask-global", { headline: "Need a decision" }));
  assert.equal(ask.channelId, null);
  assert.equal(ask.threadId, null);
});

test("an ask with no headline is not renderable and reads as null", () => {
  assert.equal(readAsk(askEvent("ask-2", { type: "decision" })), null);
  assert.equal(readAsk(askEvent("ask-3", {})), null);
});

test("a non-ask kind reads as null", () => {
  assert.equal(readAsk({ ...askEvent("m", {}), kind: 9 }), null);
});

test("malformed content reads as null rather than throwing", () => {
  assert.equal(
    readAsk({ ...askEvent("ask-4", {}), content: "{not json" }),
    null,
  );
});

test("an answered ask drops out of the open list", () => {
  const asks = [
    readAsk(askEvent("ask-1", { type: "decision", headline: "A" })),
    readAsk(askEvent("ask-2", { type: "question", headline: "B" })),
  ];
  const open = selectOpenAsks(asks, ["ask-1"]);
  assert.deepEqual(
    open.map((ask) => ask.id),
    ["ask-2"],
    "an ask a superior already answered must never show on the owner's surface",
  );
});

test("the open list is newest first", () => {
  const older = {
    ...readAsk(askEvent("old", { headline: "A" })),
    createdAt: 1,
  };
  const newer = {
    ...readAsk(askEvent("new", { headline: "B" })),
    createdAt: 9,
  };
  assert.deepEqual(
    selectOpenAsks([older, newer], []).map((ask) => ask.id),
    ["new", "old"],
  );
});

function askState(askId, status) {
  return { askId, status, defaultExecuted: false };
}

test("an ask closed only by its relay-signed state head is excluded — the auto-resolve-via-thread-reply case", () => {
  // try_auto_resolve_from_reply (buzz-relay/src/ask_broker.rs) publishes no
  // 44301/44302 at all: the state head is the ONLY signal this path
  // produces, so a caller passing only closure events would show this ask
  // as open forever.
  const open = { ...readAsk(askEvent("open-ask", { headline: "Still open" })) };
  const resolved = {
    ...readAsk(askEvent("resolved-ask", { headline: "Answered in-thread" })),
  };
  const states = new Map([[resolved.id, askState(resolved.id, "resolved")]]);
  assert.deepEqual(
    selectOpenAsks([open, resolved], [], states).map((ask) => ask.id),
    ["open-ask"],
  );
});

test("withdrawn and promoted state-head statuses are excluded too", () => {
  const withdrawn = readAsk(askEvent("withdrawn-ask", { headline: "A" }));
  const promoted = readAsk(askEvent("promoted-ask", { headline: "B" }));
  const open = readAsk(askEvent("open-ask", { headline: "C" }));
  const states = new Map([
    [withdrawn.id, askState(withdrawn.id, "withdrawn")],
    [promoted.id, askState(promoted.id, "promoted")],
  ]);
  assert.deepEqual(
    selectOpenAsks([withdrawn, promoted, open], [], states)
      .map((ask) => ask.id)
      .sort(),
    ["open-ask"],
  );
});

test("an ask-state head naming status open never excludes anything", () => {
  const ask = readAsk(askEvent("ask-1", { headline: "Still open" }));
  const states = new Map([[ask.id, askState(ask.id, "open")]]);
  assert.deepEqual(
    selectOpenAsks([ask], [], states).map((a) => a.id),
    ["ask-1"],
  );
});

const RELAY_HEX = "e".repeat(64);
const IMPOSTOR_HEX = "f".repeat(64);
// The `d` tag on a state head is validated as 64-char hex (`readAskState`),
// exactly like a real ask event id — a non-hex id like the `askEvent` helper's
// plain string ids above would fail that check and silently produce no
// state at all, which is not what these tests are exercising.
const HEX_ASK_ID = "1".repeat(64);

function stateHeadEvent(askId, status, overrides = {}) {
  return {
    id: `state-${askId}`,
    kind: 30200,
    pubkey: RELAY_HEX,
    created_at: 500,
    content: JSON.stringify({ status, default_executed: false }),
    tags: [["d", askId]],
    sig: "",
    ...overrides,
  };
}

test("SECURITY: closed by a relay-authored state head end to end", () => {
  const ask = readAsk({
    ...askEvent(HEX_ASK_ID, { headline: "Needs a decision" }),
    id: HEX_ASK_ID,
  });
  const states = askStatesFromEvents(
    [stateHeadEvent(ask.id, "resolved")],
    RELAY_HEX,
  );
  assert.deepEqual(
    selectOpenAsks([ask], [], states).map((a) => a.id),
    [],
    "a state head genuinely signed by the relay must close the ask",
  );
});

test("SECURITY: the same state head authored by anyone else is ignored end to end", () => {
  // The forgery scenario the relay-thread-reply close path exists to guard
  // against: a worker agent (or any other authenticated member) publishing
  // its own kind-30200 head naming its own ask "resolved" to hide it from
  // the owner's queue. `askStatesFromEvents` drops any head not signed by
  // the relay's own pubkey (`readAskState`'s authorship check,
  // `askState.test.mjs` covers that in isolation); this proves the full
  // pipeline `selectOpenAsks` actually runs on still keeps the ask open
  // when a forged head is all that exists.
  const ask = readAsk({
    ...askEvent(HEX_ASK_ID, { headline: "Needs a decision" }),
    id: HEX_ASK_ID,
  });
  const states = askStatesFromEvents(
    [stateHeadEvent(ask.id, "resolved", { pubkey: IMPOSTOR_HEX })],
    RELAY_HEX,
  );
  assert.deepEqual(
    selectOpenAsks([ask], [], states).map((a) => a.id),
    [HEX_ASK_ID],
    "a forged state head must never close an ask — it must be dropped before selectOpenAsks ever sees it",
  );
});

const AUDIENCE = "a".repeat(64);
const PRIOR = "b".repeat(64);
const ORIGINAL_FILER = "c".repeat(64);

test("an ask names its audience through its p tag", () => {
  const ask = readAsk({
    ...askEvent("ask-audience", { headline: "Need a decision" }),
    tags: [["p", AUDIENCE]],
  });
  assert.equal(ask.audiencePubkey, AUDIENCE);
});

test("a plain ask has no routing provenance", () => {
  const ask = readAsk(askEvent("ask-plain", { headline: "Need a decision" }));
  assert.equal(ask.audiencePubkey, null);
  assert.equal(ask.priorAskId, null);
  assert.equal(ask.originalFilerPubkey, null);
});

test("a relay-promoted successor carries prior and original-filer provenance", () => {
  const ask = readAsk({
    ...askEvent("ask-successor", { headline: "Still blocked" }),
    tags: [
      ["p", AUDIENCE],
      ["prior", PRIOR],
      ["filer", ORIGINAL_FILER],
    ],
  });
  assert.equal(ask.audiencePubkey, AUDIENCE);
  assert.equal(ask.priorAskId, PRIOR);
  assert.equal(ask.originalFilerPubkey, ORIGINAL_FILER);
});

test("an ambiguous audience reads as no audience, exactly as the relay parses it", () => {
  const ask = readAsk({
    ...askEvent("ask-ambiguous", { headline: "Need a decision" }),
    tags: [
      ["p", AUDIENCE],
      ["p", ORIGINAL_FILER],
    ],
  });
  assert.equal(ask.audiencePubkey, null);
});

test("malformed routing tags degrade to null rather than throwing", () => {
  const ask = readAsk({
    ...askEvent("ask-malformed-tags", { headline: "Need a decision" }),
    tags: [
      ["p", "not-hex"],
      ["prior", "also-not-hex"],
      ["filer", ""],
    ],
  });
  assert.equal(ask.audiencePubkey, null);
  assert.equal(ask.priorAskId, null);
  assert.equal(ask.originalFilerPubkey, null);
});

test("reads every `task` tag, raw and undeduplicated, for blast radius", () => {
  const ask = readAsk({
    ...askEvent("ask-tasks", { headline: "Fix the outage" }),
    tags: [
      ["task", "task-1"],
      ["task", "task-2"],
      ["task", "task-1"],
    ],
  });
  assert.deepEqual(ask.taskIds, ["task-1", "task-2", "task-1"]);
});

test("an ask with no task tags has an empty blast radius", () => {
  const ask = readAsk(
    askEvent("ask-no-tasks", { headline: "Need a decision" }),
  );
  assert.deepEqual(ask.taskIds, []);
});

test("category preserves its filed case; the hard list is matched elsewhere, case-insensitively", () => {
  const ask = readAsk({
    ...askEvent("ask-category", { headline: "Approve the spend" }),
    tags: [["category", "SPEND"]],
  });
  assert.equal(ask.category, "SPEND");
});

test("an ambiguous category tag reads as no category", () => {
  const ask = readAsk({
    ...askEvent("ask-category-dupe", { headline: "Need a decision" }),
    tags: [
      ["category", "spend"],
      ["category", "legal"],
    ],
  });
  assert.equal(ask.category, null);
});

test("default_option and default_window_secs come off the content, not tags", () => {
  const ask = readAsk(
    askEvent("ask-default", {
      headline: "Ship the deploy window?",
      default_option: "Friday 6pm",
      default_window_secs: 3_600,
    }),
  );
  assert.equal(ask.defaultOption, "Friday 6pm");
  assert.equal(ask.defaultWindowSecs, 3_600);
});

test("an ask with no default fields reads both as null", () => {
  const ask = readAsk(
    askEvent("ask-no-default", { headline: "Need a decision" }),
  );
  assert.equal(ask.defaultOption, null);
  assert.equal(ask.defaultWindowSecs, null);
});

test("a negative or non-integer default_window_secs reads as null rather than a bad number", () => {
  const negative = readAsk(
    askEvent("ask-negative-window", {
      headline: "Need a decision",
      default_window_secs: -1,
    }),
  );
  assert.equal(negative.defaultWindowSecs, null);
  const fractional = readAsk(
    askEvent("ask-fractional-window", {
      headline: "Need a decision",
      default_window_secs: 12.5,
    }),
  );
  assert.equal(fractional.defaultWindowSecs, null);
});

test("initiative id is read from its tag, the reserved no-initiative value included", () => {
  const scoped = readAsk({
    ...askEvent("ask-initiative", { headline: "Need a decision" }),
    tags: [["initiative", "website-relaunch"]],
  });
  assert.equal(scoped.initiativeId, "website-relaunch");

  const unscoped = readAsk({
    ...askEvent("ask-no-initiative", { headline: "Need a decision" }),
    tags: [["initiative", "no-initiative"]],
  });
  assert.equal(unscoped.initiativeId, "no-initiative");
});
