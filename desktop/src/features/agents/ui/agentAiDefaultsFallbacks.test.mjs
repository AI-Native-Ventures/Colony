import assert from "node:assert/strict";
import test from "node:test";

import {
  aiDefaultsSummaryRows,
  formatFallbacksSummary,
} from "./AgentAiDefaults.tsx";

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

test("the summary is the Customize rows, read-only", () => {
  // Same labels, same order, so the two tabs of one dialog read alike.
  const rows = aiDefaultsSummaryRows({
    explicitModel: "",
    explicitProvider: "",
    fallbacks: { entries: ["a/one:free"], source: "relay" },
    harness: "Colony Agent",
    model: "z/primary:free",
    provider: "openrouter",
  });
  assert.deepEqual(
    rows.map((row) => row.label),
    ["Harness", "Provider", "Model", "Fallbacks"],
  );
  assert.deepEqual(
    rows.map((row) => row.custom),
    [false, false, false, false],
  );
});

test("a pin on the agent is what turns a summary row custom", () => {
  const rows = aiDefaultsSummaryRows({
    explicitModel: "thinkingmachines/inkling:free",
    explicitProvider: "",
    fallbacks: { entries: ["a/one:free"], source: "agent" },
    model: "thinkingmachines/inkling:free",
    provider: "openrouter",
  });
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row]));
  assert.equal(byLabel.Model.custom, true);
  assert.equal(byLabel.Provider.custom, false);
  assert.equal(byLabel.Fallbacks.custom, true);
  // No harness passed: the instance editor has no harness row to show.
  assert.equal(byLabel.Harness, undefined);
});

test("an unset value reads as not configured rather than blank", () => {
  const rows = aiDefaultsSummaryRows({
    explicitModel: "",
    explicitProvider: "",
    model: "",
    provider: "",
  });
  assert.deepEqual(
    rows.map((row) => row.value),
    ["Not configured", "Not configured"],
  );
});
