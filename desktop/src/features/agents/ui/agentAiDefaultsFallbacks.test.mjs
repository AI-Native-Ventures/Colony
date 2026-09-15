import assert from "node:assert/strict";
import test from "node:test";

import { formatFallbacksSummary } from "./AgentAiDefaults.tsx";

test("an inherited relay chain says whose chain it is", () => {
  assert.equal(
    formatFallbacksSummary({
      entries: ["a/one:free", "b/two:free"],
      source: "relay",
    }),
    "a/one:free, b/two:free (Colony recommended)",
  );
});

test("an owner-authored chain is listed without a label", () => {
  assert.equal(
    formatFallbacksSummary({ entries: ["a/one:free"], source: "global" }),
    "a/one:free",
  );
  assert.equal(
    formatFallbacksSummary({ entries: ["a/one:free"], source: "agent" }),
    "a/one:free",
  );
});

test("an empty chain is a decision, not a missing value", () => {
  assert.equal(
    formatFallbacksSummary({ entries: [], source: "agent" }),
    "None",
  );
  assert.equal(
    formatFallbacksSummary({ entries: [], source: "relay" }),
    "None",
  );
});
