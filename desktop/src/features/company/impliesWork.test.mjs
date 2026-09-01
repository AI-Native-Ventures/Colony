import assert from "node:assert/strict";
import { test } from "node:test";

import { impliesWork } from "./impliesWork.ts";

test("a presence check is not work", () => {
  assert.equal(impliesWork("@Chief of Staff are you here?"), false);
  assert.equal(impliesWork("@Scout you there"), false);
});

test("greetings and acknowledgements are not work", () => {
  for (const message of [
    "@Scout hi",
    "@Scout thanks",
    "@Scout thank you",
    "@Scout ok",
    "@Scout got it",
    "@Scout good morning",
  ]) {
    assert.equal(impliesWork(message), false, message);
  }
});

test("an instruction is work even when it is short", () => {
  assert.equal(impliesWork("@Scout ship it"), true);
  assert.equal(impliesWork("@Scout fix the footer"), true);
});

test("an acknowledgement followed by an instruction is work", () => {
  assert.equal(impliesWork("@Scout thanks, now ship it"), true);
});

test("markdown emphasis does not hide the instruction", () => {
  assert.equal(
    impliesWork(
      "@Chief of Staff **find out and let me know about the latest openclaw changes**",
    ),
    true,
  );
});

test("the same message with and without markdown decides the same way", () => {
  assert.equal(
    impliesWork("@Scout **are you there?**"),
    impliesWork("@Scout are you there?"),
  );
});

test("a message that is only a mention mints nothing", () => {
  assert.equal(impliesWork("@Chief of Staff"), false);
  assert.equal(impliesWork("   "), false);
});

test("a question that asks for something is work", () => {
  assert.equal(impliesWork("@Scout what changed in the release?"), true);
});

test("case and trailing punctuation do not change the decision", () => {
  assert.equal(impliesWork("@Scout ARE YOU THERE???"), false);
  assert.equal(impliesWork("@Scout Thanks!"), false);
});
