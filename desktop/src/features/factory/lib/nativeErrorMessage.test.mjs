import assert from "node:assert/strict";
import test from "node:test";

import { nativeErrorMessage } from "./nativeErrorMessage.ts";

test("an Error keeps its message", () => {
  assert.equal(
    nativeErrorMessage(new Error("this project has no local checkout"), "fb"),
    "this project has no local checkout",
  );
});

test("a string rejection is the message, trimmed", () => {
  assert.equal(
    nativeErrorMessage("  git was not found  ", "fb"),
    "git was not found",
  );
});

test("an object carrying error or message is read", () => {
  assert.equal(
    nativeErrorMessage({ error: "clone failed" }, "fb"),
    "clone failed",
  );
  assert.equal(
    nativeErrorMessage({ message: "clone failed" }, "fb"),
    "clone failed",
  );
  assert.equal(
    nativeErrorMessage({ error: "  ", message: "clone failed" }, "fb"),
    "clone failed",
  );
});

test("empty and unusable values fall back", () => {
  assert.equal(nativeErrorMessage("   ", "fb"), "fb");
  assert.equal(nativeErrorMessage(new Error(""), "fb"), "fb");
  assert.equal(nativeErrorMessage(null, "fb"), "fb");
  assert.equal(nativeErrorMessage(undefined, "fb"), "fb");
  assert.equal(nativeErrorMessage(42, "fb"), "fb");
  assert.equal(nativeErrorMessage({ code: 5 }, "fb"), "fb");
});
