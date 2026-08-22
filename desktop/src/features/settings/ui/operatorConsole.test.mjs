import assert from "node:assert/strict";
import test from "node:test";

import {
  buttonLabel,
  checkingAccessMessage,
  consoleOpenErrorMessage,
  isOperatorRole,
  noAccessMessage,
} from "./operatorConsole.ts";

test("only relay owners and admins pass the operator gate", () => {
  assert.equal(isOperatorRole("owner"), true);
  assert.equal(isOperatorRole("admin"), true);
});

test("everyone else is kept out of the operator gate", () => {
  assert.equal(isOperatorRole("member"), false);
  assert.equal(isOperatorRole("moderator"), false);
  assert.equal(isOperatorRole(""), false);
  assert.equal(isOperatorRole(null), false);
  assert.equal(isOperatorRole(undefined), false);
});

// The gate is a convenience filter, not the authority; these copies only
// explain state and must not imply the relay was consulted about access.
test("access copy distinguishes loading from a definite no", () => {
  assert.equal(checkingAccessMessage(), "Checking access…");
  assert.match(noAccessMessage(), /community admins only/);
});

test("button label reflects an in-flight open request", () => {
  assert.equal(buttonLabel(false), "Open admin console");
  assert.equal(buttonLabel(true), "Opening…");
});

test("rust rejection strings surface verbatim to the card", () => {
  const refusal =
    "refusing to sign for https://evil.test: the operator console may only authenticate to https://admin.colony.ainative.ventures";
  assert.equal(consoleOpenErrorMessage(new Error(refusal)), refusal);
});

test("non-error rejections fall back to friendly copy", () => {
  assert.equal(
    consoleOpenErrorMessage({ unexpected: true }),
    "The admin console did not open.",
  );
  assert.equal(
    consoleOpenErrorMessage(undefined),
    "The admin console did not open.",
  );
});

test("tauri-style string rejections are shown as-is", () => {
  // invokeTauri rejects with Error, but the raw bridge can reject with the
  // plain string payload; both must render something useful.
  assert.equal(
    consoleOpenErrorMessage("identity unavailable"),
    "identity unavailable",
  );
});
