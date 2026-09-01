import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PICKS,
  MAX_REFERENCES,
  addStyleReference,
  appendStyleRule,
  buildStyleEvent,
  recordStylePick,
  removeStyleReference,
  revokeStyleRule,
  setStyleVoice,
} from "./styleRecord.ts";

test("appending a rule keeps every field this build has never heard of", () => {
  const existing = {
    future_field: { nested: true },
    rules: [
      {
        active: true,
        id: "r1-1",
        origin: { at: 1, quote: "old" },
        text: "old rule",
      },
    ],
    schema: "colony/content-style/v1",
    settings: { banned_words: ["synergy"], mystery: 42 },
    version: "1",
  };
  const body = appendStyleRule(existing, "Less text on cards", {
    at: 1000,
    event: "deadbeef",
    quote: "way too much text on this one",
  });
  assert.deepEqual(body.future_field, { nested: true });
  assert.equal(body.settings.mystery, 42);
  assert.deepEqual(body.settings.banned_words, ["synergy"]);
  assert.equal(body.rules.length, 2);
  const added = body.rules[1];
  assert.equal(added.text, "Less text on cards");
  assert.equal(added.origin.quote, "way too much text on this one");
  assert.equal(added.origin.event, "deadbeef");
  assert.equal(added.active, true);
  assert.equal(added.id, "r1000-2");
  // The version bump is what makes existing cards read as stale.
  assert.equal(body.version, "1000");
});

test("a first rule on a workspace with no style record still lands", () => {
  const body = appendStyleRule(null, "Never mention pricing", {
    at: 7,
    quote: "never mention pricing",
  });
  assert.equal(body.schema, "colony/content-style/v1");
  assert.equal(body.rules.length, 1);
  assert.equal(body.rules[0].id, "r7-1");
});

test("revoking keeps the rule, inactive, for the audit", () => {
  const existing = appendStyleRule(null, "No emoji", {
    at: 5,
    quote: "no emoji",
  });
  const body = revokeStyleRule(existing, "r5-1", 9);
  assert.equal(body.rules.length, 1);
  assert.equal(body.rules[0].active, false);
  assert.equal(body.rules[0].text, "No emoji");
  assert.equal(body.version, "9");
});

test("references dedupe by hash and the oldest fall off past the cap", () => {
  let body = null;
  for (let i = 0; i < MAX_REFERENCES + 3; i += 1) {
    body = addStyleReference(body, {
      added_at: i,
      sha256: `hash-${i}`,
      url: `https://relay/media/${i}`,
    });
  }
  assert.equal(body.settings.references.length, MAX_REFERENCES);
  assert.equal(body.settings.references[0].sha256, "hash-3");

  // Re-adding an existing hash moves it, not duplicates it.
  body = addStyleReference(body, {
    added_at: 999,
    sha256: "hash-10",
    url: "https://relay/media/10",
  });
  const hashes = body.settings.references.map((entry) => entry.sha256);
  assert.equal(hashes.filter((hash) => hash === "hash-10").length, 1);
  assert.equal(hashes[hashes.length - 1], "hash-10");

  body = removeStyleReference(body, "hash-10", 1000);
  assert.ok(
    !body.settings.references.some((entry) => entry.sha256 === "hash-10"),
  );
});

test("voice sets and clears without touching neighbours", () => {
  const existing = {
    rules: [],
    schema: "colony/content-style/v1",
    settings: { references: [{ sha256: "x", url: "u" }] },
  };
  const set = setStyleVoice(
    existing,
    { banned_words: [" synergy ", ""], sound: "Plain.", tagline: "Do more." },
    50,
  );
  assert.equal(set.settings.voice.tagline, "Do more.");
  assert.equal(set.settings.voice.sound, "Plain.");
  assert.deepEqual(set.settings.banned_words, ["synergy"]);
  assert.deepEqual(set.settings.references, [{ sha256: "x", url: "u" }]);

  const cleared = setStyleVoice(
    set,
    { banned_words: [], sound: "", tagline: "" },
    60,
  );
  assert.deepEqual(cleared.settings.voice, {});
  // The event drops the cleared list entirely rather than writing null.
  const event = buildStyleEvent("house", cleared);
  assert.ok(!JSON.parse(event.content).settings.banned_words);
});

test("picks accumulate, cap, and never bump the version", () => {
  let body = appendStyleRule(null, "rule", { at: 1, quote: "q" });
  for (let i = 0; i < MAX_PICKS + 5; i += 1) {
    body = recordStylePick(body, {
      at: i,
      chosen: { hues: ["violet"], layout: "poster" },
      post: `campaign:post-${i}`,
    });
  }
  assert.equal(body.settings.picks.length, MAX_PICKS);
  assert.equal(body.settings.picks[0].post, "campaign:post-5");
  // A pick biases future drafts; it does not make old cards stale.
  assert.equal(body.version, "1");
});

test("the event carries the d tag and the merged body", () => {
  const body = appendStyleRule(null, "rule", { at: 3, quote: "q" });
  const event = buildStyleEvent("house", body);
  assert.equal(event.kind, 30197);
  assert.deepEqual(event.tags, [["d", "house"]]);
  assert.equal(JSON.parse(event.content).version, "3");
});
