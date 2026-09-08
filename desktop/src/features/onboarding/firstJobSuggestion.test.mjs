import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FIRST_JOB_SUGGESTION_MARKER,
  firstJobSuggestionBody,
  firstJobSuggestionTag,
  parseFirstJobSuggestion,
  canStartFirstJobSuggestion,
} from "./firstJobSuggestion.ts";

const owner = "a".repeat(64);
const channelId = "welcome-one";
const relayUrl = "wss://horizon.example";
const payload = {
  version: 1,
  ownerPubkey: owner,
  relayUrl,
  channelId,
  requestId: "onboarding-attempt-1",
  businessName: "Horizon Labs",
  business: "Horizon Labs provides branding and websites.",
  website: "https://horizon.example/",
  brief: "Draft a week of social post ideas for Horizon Labs.",
};
const tag = (value) => [
  "client",
  FIRST_JOB_SUGGESTION_MARKER,
  JSON.stringify(value),
];
const message = (tags = [tag(payload)]) => ({
  id: "b".repeat(64),
  signerPubkey: owner,
  pubkey: owner,
  kind: 9,
  tags: [["h", channelId], ...tags],
});

test("setup payload round trips without becoming an automatic instruction", () => {
  assert.deepEqual(
    parseFirstJobSuggestion([firstJobSuggestionTag(payload)]),
    payload,
  );
  const body = firstJobSuggestionBody(payload);
  assert.match(body, /Setup suggestion/);
  assert.match(body, /Nothing starts until you choose Start/);
  assert.ok(body.includes(payload.brief));
  assert.doesNotMatch(body, /I am on it|You asked me|@Scout/);
});

test("malformed, ambiguous and unbounded payloads are ordinary messages", () => {
  for (const tags of [
    [],
    [tag({ ...payload, version: 2 })],
    [tag({ ...payload, brief: "x".repeat(4001) })],
    [tag({ ...payload, brief: "" })],
    [tag({ ...payload, ownerPubkey: "bad" })],
    [tag({ ...payload, requestId: "a/b" })],
    [tag({ ...payload, business: "bad\u0000text" })],
    [["client", FIRST_JOB_SUGGESTION_MARKER, "{"]],
    [tag(payload), tag(payload)],
    [["client", FIRST_JOB_SUGGESTION_MARKER, JSON.stringify(payload), "extra"]],
  ])
    assert.equal(parseFirstJobSuggestion(tags), null);
});

test("website and community fields never allow credential-bearing or executable URLs", () => {
  for (const website of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "https://me:secret@example.com/",
  ]) {
    assert.equal(parseFirstJobSuggestion([tag({ ...payload, website })]), null);
  }
  for (const relay of [
    "https://horizon.example",
    "wss://me:secret@example.com",
    "wss://horizon.example/#other",
  ]) {
    assert.equal(
      parseFirstJobSuggestion([tag({ ...payload, relayUrl: relay })]),
      null,
    );
  }
  assert.ok(parseFirstJobSuggestion([tag({ ...payload, website: "" })]));
});

test("only the actual owner can start an unedited root in its exact community and channel", () => {
  const scope = { ownerPubkey: owner, relayUrl, channelId };
  assert.equal(canStartFirstJobSuggestion(message(), scope), true);
  for (const patch of [
    { signerPubkey: "c".repeat(64) },
    { pubkey: "c".repeat(64) },
    { pending: true },
    { kind: 40003 },
    { id: "pending-id" },
    { tags: [["h", "different"], tag(payload)] },
    { tags: [["h", channelId], ["h", "different"], tag(payload)] },
    {
      tags: [
        ["h", channelId],
        ["e", "d".repeat(64), "", "reply"],
        tag(payload),
      ],
    },
  ])
    assert.equal(
      canStartFirstJobSuggestion({ ...message(), ...patch }, scope),
      false,
    );
  for (const changed of [
    { ownerPubkey: "c".repeat(64) },
    { relayUrl: "wss://another.example" },
    { channelId: "different" },
  ])
    assert.equal(
      canStartFirstJobSuggestion(message(), { ...scope, ...changed }),
      false,
    );
});
