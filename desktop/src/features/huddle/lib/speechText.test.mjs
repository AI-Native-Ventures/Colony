import assert from "node:assert/strict";
import test from "node:test";

import { CODE_ONLY_SPOKEN_NOTICE, toSpeechText } from "./speechText.ts";

test("plain text passes through unchanged", () => {
  assert.equal(
    toSpeechText("Sounds good, starting now."),
    "Sounds good, starting now.",
  );
});

test("headings lose their hashes", () => {
  assert.equal(toSpeechText("## Plan\nFirst we ship."), "Plan\nFirst we ship.");
});

test("emphasis markers are stripped, words kept", () => {
  assert.equal(
    toSpeechText("This is **very** important, *really* - not ~~optional~~."),
    "This is very important, really - not optional.",
  );
});

test("links speak their text, bare URLs are dropped", () => {
  assert.equal(
    toSpeechText(
      "See [the docs](https://example.com/a#b) or https://example.com/raw",
    ),
    "See the docs or",
  );
});

test("bullet lists speak items without markers", () => {
  assert.equal(
    toSpeechText("- first thing\n- second thing"),
    "first thing\nsecond thing",
  );
});

test("ordered lists keep their numbers", () => {
  assert.equal(toSpeechText("1. gather\n2) decide"), "1. gather\n2. decide");
});

test("fenced code blocks are removed from mixed messages", () => {
  assert.equal(
    toSpeechText("Here is the fix:\n```rust\nlet x = 1;\n```\nDeployed it."),
    "Here is the fix:\n\nDeployed it.",
  );
});

test("code-only messages become a spoken notice, not silence", () => {
  assert.equal(
    toSpeechText("```js\nconsole.log(1)\n```"),
    CODE_ONLY_SPOKEN_NOTICE,
  );
});

test("inline code speaks its contents", () => {
  assert.equal(
    toSpeechText("Run `just ci` before pushing."),
    "Run just ci before pushing.",
  );
});

test("tables read as comma-separated rows", () => {
  assert.equal(
    toSpeechText("| Name | Role |\n| --- | --- |\n| Sift | Sales |"),
    "Name, Role\nSift, Sales",
  );
});

test("blockquotes and rules vanish", () => {
  assert.equal(
    toSpeechText("> quoted wisdom\n\n---\n\ndone"),
    "quoted wisdom\n\ndone",
  );
});

test("nostr URIs are not spoken", () => {
  assert.equal(
    toSpeechText("cc nostr:npub1abcdef please review"),
    "cc please review",
  );
});

test("snake_case identifiers survive italic stripping", () => {
  assert.equal(
    toSpeechText("check the max_uses field"),
    "check the max_uses field",
  );
});

test("whitespace-only result stays empty so callers skip synthesis", () => {
  assert.equal(toSpeechText("   \n\n  "), "");
});
