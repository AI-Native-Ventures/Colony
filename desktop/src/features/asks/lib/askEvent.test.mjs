import assert from "node:assert/strict";
import test from "node:test";

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
