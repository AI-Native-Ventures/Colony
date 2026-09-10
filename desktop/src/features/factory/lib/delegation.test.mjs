import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDelegationContent,
  delegationClientTags,
  deriveDelegationCards,
  readDelegationPayload,
  REPLY_EXPECTED_LINE,
} from "./delegation.ts";

const AVERY = "a".repeat(64);
const VERA = "b".repeat(64);
const STRANGER = "c".repeat(64);

const NAMES = { [AVERY]: "Avery", [VERA]: "Vera" };
const nameFor = (pubkey) => NAMES[pubkey] ?? "Unknown";

function delegationEvent(overrides = {}) {
  const payload = {
    from: AVERY,
    to: VERA,
    replyExpected: true,
    ...(overrides.payload ?? {}),
  };
  return {
    id: overrides.id ?? "event-1",
    content:
      overrides.content ??
      buildDelegationContent("Review #684.", payload.replyExpected),
    tags: overrides.tags ?? [
      ["h", "channel"],
      ...delegationClientTags(payload),
    ],
  };
}

test("the body states the expectation the agent reads as text", () => {
  assert.equal(
    buildDelegationContent("  Review #684.  ", true),
    `Review #684.\n\n${REPLY_EXPECTED_LINE}`,
  );
  assert.equal(buildDelegationContent("Review #684.", false), "Review #684.");
});

test("the marker round-trips both sides of the delegation", () => {
  const tags = delegationClientTags({
    from: AVERY,
    to: VERA,
    replyExpected: true,
  });
  assert.equal(tags[0][0], "client");
  assert.equal(tags[0][1], "colony-delegation");
  assert.deepEqual(readDelegationPayload({ id: "x", content: "", tags }), {
    from: AVERY,
    to: VERA,
    replyExpected: true,
  });
});

test("a malformed or absent marker yields no payload", () => {
  assert.equal(
    readDelegationPayload({ id: "x", content: "", tags: [["h", "c"]] }),
    null,
  );
  assert.equal(
    readDelegationPayload({
      id: "x",
      content: "",
      tags: [["client", "colony-delegation", "{not json"]],
    }),
    null,
  );
  assert.equal(
    readDelegationPayload({
      id: "x",
      content: "",
      tags: [["client", "colony-delegation", JSON.stringify({ from: AVERY })]],
    }),
    null,
  );
});

test("the delegator sees an outgoing card, the delegate an incoming one", () => {
  const events = [delegationEvent()];
  const [outgoing] = deriveDelegationCards({
    events,
    agentPubkey: AVERY,
    nameFor,
  });
  assert.equal(outgoing.direction, "outgoing");
  assert.equal(outgoing.label, "Delegated to Vera · reply expected");
  assert.equal(outgoing.body, "Review #684.");

  const [incoming] = deriveDelegationCards({
    events,
    agentPubkey: VERA,
    nameFor,
  });
  assert.equal(incoming.direction, "incoming");
  assert.equal(incoming.label, "From Avery · reply expected");
  assert.equal(incoming.counterpartPubkey, AVERY);
});

test("an agent outside the delegation sees nothing", () => {
  assert.deepEqual(
    deriveDelegationCards({
      events: [delegationEvent()],
      agentPubkey: STRANGER,
      nameFor,
    }),
    [],
  );
});

test("no expectation drops the suffix and keeps the whole body", () => {
  const [card] = deriveDelegationCards({
    events: [
      delegationEvent({
        payload: { replyExpected: false },
        content: "Have a look when you can.",
      }),
    ],
    agentPubkey: AVERY,
    nameFor,
  });
  assert.equal(card.label, "Delegated to Vera");
  assert.equal(card.replyExpected, false);
  assert.equal(card.body, "Have a look when you can.");
});

test("pubkey case never splits a delegation from its own tile", () => {
  const [card] = deriveDelegationCards({
    events: [delegationEvent()],
    agentPubkey: AVERY.toUpperCase(),
    nameFor,
  });
  assert.equal(card.direction, "outgoing");
});

test("a repeated event id is only carded once", () => {
  const cards = deriveDelegationCards({
    events: [delegationEvent(), delegationEvent()],
    agentPubkey: AVERY,
    nameFor,
  });
  assert.equal(cards.length, 1);
});

test("non-delegation events in the thread are ignored", () => {
  assert.deepEqual(
    deriveDelegationCards({
      events: [{ id: "plain", content: "hello", tags: [["h", "channel"]] }],
      agentPubkey: AVERY,
      nameFor,
    }),
    [],
  );
});
