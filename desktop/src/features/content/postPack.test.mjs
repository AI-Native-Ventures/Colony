// The handover pack, tested without a browser.
//
// This is the text a person pastes into a posting box, so the order is the
// product: caption, hashtags, then alt text under a label because alt goes in
// a different field and pasting it into the caption is the obvious failure.

import assert from "node:assert/strict";
import test from "node:test";

import { packFilename, postPackText } from "./postPack.ts";

const post = (overrides = {}) => ({
  alt: "A violet card reading: Run a company without the headcount.",
  caption: "Most tools give you a faster way to do your own work.",
  claims: [],
  hashtags: ["agents", "AI"],
  scheduledFor: "2026-08-31",
  slug: "w1-mon-who",
  ...overrides,
});

test("the caption leads, because that is what goes in the box", () => {
  const text = postPackText(post());
  assert.ok(text.startsWith("Most tools give you"));
});

test("hashtags sit on their own line, prefixed once", () => {
  assert.match(postPackText(post()), /\n\n#agents #AI\n/);
});

test("alt text is labelled, because it is typed into a different field", () => {
  assert.match(postPackText(post()), /Alt text: A violet card reading/);
});

test("a sourced card says nothing about claims", () => {
  const text = postPackText(
    post({ claims: [{ asserts: "x", id: "c1", source: { type: "page" } }] }),
  );
  assert.doesNotMatch(text, /claims/i);
});

test("an unsourced claim warns the person about to publish", () => {
  const text = postPackText(
    post({ claims: [{ asserts: "Nine out of ten", id: "c1", source: null }] }),
  );
  assert.match(
    text,
    /Unsourced claims, do not publish without checking: "Nine out of ten"/,
  );
});

test("a card with only a caption produces no stray blank lines", () => {
  assert.equal(
    postPackText(post({ alt: null, hashtags: [] })),
    "Most tools give you a faster way to do your own work.",
  );
});

test("the filename carries the date and the slug", () => {
  assert.equal(packFilename(post(), 0, 1), "2026-08-31-w1-mon-who.png");
});

test("a carousel numbers its slides", () => {
  assert.equal(packFilename(post(), 2, 4), "2026-08-31-w1-mon-who-3.png");
});

test("a slug that would escape a directory is scrubbed", () => {
  assert.equal(
    packFilename(post({ slug: "../../etc/passwd" }), 0, 1),
    "2026-08-31-etc-passwd.png",
  );
});
