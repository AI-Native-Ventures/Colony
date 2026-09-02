import assert from "node:assert/strict";
import test from "node:test";

import { validateAgentsSearch } from "./agentsSearch.ts";

test("agents search keeps profile panel state", () => {
  assert.deepEqual(
    validateAgentsSearch({
      profile: "abc123",
      profilePersona: "custom:reviewer",
      profileTab: "runtime",
      profileView: "diagnostics",
    }),
    {
      profile: "abc123",
      profilePersona: "custom:reviewer",
      profileTab: "runtime",
      profileView: "diagnostics",
    },
  );
});

test("agents search drops empty profile values", () => {
  assert.deepEqual(
    validateAgentsSearch({
      profile: "",
      profilePersona: 42,
      profileTab: "not-a-tab",
      profileView: null,
    }),
    {
      profile: undefined,
      profilePersona: undefined,
      profileTab: undefined,
      profileView: undefined,
    },
  );
});

test("agents search ignores the retired section param", () => {
  assert.deepEqual(validateAgentsSearch({ section: "people" }), {
    profile: undefined,
    profilePersona: undefined,
    profileTab: undefined,
    profileView: undefined,
  });
  assert.deepEqual(validateAgentsSearch({ section: 7 }), {
    profile: undefined,
    profilePersona: undefined,
    profileTab: undefined,
    profileView: undefined,
  });
});
