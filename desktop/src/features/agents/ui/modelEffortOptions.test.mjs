import assert from "node:assert/strict";
import { test } from "node:test";

import {
  baseModelOptions,
  composeModelId,
  effortsForModel,
  modelAllowsInheritedEffort,
  splitStoredModel,
} from "./modelEffortOptions.ts";

/**
 * Trimmed from a live `buzz-acp models --json` run against
 * @agentclientprotocol/codex-acp 1.1.7. The shape that matters: sol advertises
 * ultra, luna stops at max, 5.5 stops at xhigh. Any hardcoded effort list is
 * wrong for at least two of these.
 */
const CODEX = [
  {
    id: "gpt-5.6-sol",
    baseId: "gpt-5.6-sol",
    effort: null,
    name: "GPT-5.6-Sol",
  },
  {
    id: "gpt-5.6-luna",
    baseId: "gpt-5.6-luna",
    effort: null,
    name: "GPT-5.6-Luna",
  },
  { id: "gpt-5.5", baseId: "gpt-5.5", effort: null, name: "GPT-5.5" },
  {
    id: "gpt-5.6-sol[low]",
    baseId: "gpt-5.6-sol",
    effort: "low",
    name: "GPT-5.6-Sol (low)",
  },
  {
    id: "gpt-5.6-sol[max]",
    baseId: "gpt-5.6-sol",
    effort: "max",
    name: "GPT-5.6-Sol (max)",
  },
  {
    id: "gpt-5.6-sol[ultra]",
    baseId: "gpt-5.6-sol",
    effort: "ultra",
    name: "GPT-5.6-Sol (ultra)",
  },
  {
    id: "gpt-5.6-luna[low]",
    baseId: "gpt-5.6-luna",
    effort: "low",
    name: "GPT-5.6-Luna (low)",
  },
  {
    id: "gpt-5.6-luna[max]",
    baseId: "gpt-5.6-luna",
    effort: "max",
    name: "GPT-5.6-Luna (max)",
  },
  {
    id: "gpt-5.5[xhigh]",
    baseId: "gpt-5.5",
    effort: "xhigh",
    name: "GPT-5.5 (xhigh)",
  },
];

test("collapses 9 combined entries into 3 models", () => {
  assert.deepEqual(
    baseModelOptions(CODEX).map((o) => o.id),
    ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"],
    "harness ordering is preserved, frontier models first",
  );
});

test("model labels drop the effort suffix", () => {
  const sol = baseModelOptions(CODEX).find((o) => o.id === "gpt-5.6-sol");
  assert.equal(
    sol.label,
    "GPT-5.6-Sol",
    'must not read "GPT-5.6-Sol (low)" once effort is its own control',
  );
});

test("efforts are per model, never a shared list", () => {
  assert.deepEqual(effortsForModel(CODEX, "gpt-5.6-sol"), [
    "low",
    "max",
    "ultra",
  ]);
  assert.deepEqual(
    effortsForModel(CODEX, "gpt-5.6-luna"),
    ["low", "max"],
    "luna must not inherit sol's ultra",
  );
  assert.deepEqual(
    effortsForModel(CODEX, "gpt-5.5"),
    ["xhigh"],
    "5.5 must not offer max",
  );
});

test("efforts sort weakest first, not alphabetically", () => {
  const models = ["max", "low", "ultra", "high", "medium", "xhigh"].map(
    (e) => ({
      id: `m[${e}]`,
      baseId: "m",
      effort: e,
    }),
  );
  assert.deepEqual(effortsForModel(models, "m"), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
});

test("an unknown effort still appears, sorted last", () => {
  const models = [
    { id: "m[low]", baseId: "m", effort: "low" },
    { id: "m[warp]", baseId: "m", effort: "warp" },
  ];
  assert.deepEqual(
    effortsForModel(models, "m"),
    ["low", "warp"],
    "a level we have not seen before must not be dropped",
  );
});

test("a model with no advertised efforts yields none", () => {
  const models = [{ id: "solo", baseId: "solo", effort: null }];
  assert.deepEqual(
    effortsForModel(models, "solo"),
    [],
    "caller hides the control; nothing to choose is not a failed load",
  );
});

test("inherit is offered only when the bare model is advertised", () => {
  assert.equal(modelAllowsInheritedEffort(CODEX, "gpt-5.6-sol"), true);
  const pinnedOnly = [{ id: "m[high]", baseId: "m", effort: "high" }];
  assert.equal(modelAllowsInheritedEffort(pinnedOnly, "m"), false);
});

test("compose round-trips through split", () => {
  for (const [base, effort] of [
    ["gpt-5.6-sol", "ultra"],
    ["gpt-5.6-luna", null],
  ]) {
    const wire = composeModelId(base, effort);
    assert.deepEqual(splitStoredModel(wire), { baseId: base, effort });
  }
  assert.equal(composeModelId("gpt-5.6-luna", null), "gpt-5.6-luna");
  assert.equal(composeModelId("gpt-5.6-sol", "ultra"), "gpt-5.6-sol[ultra]");
});

test("an empty stored model means unset, not a model named empty", () => {
  assert.deepEqual(splitStoredModel(""), { baseId: "", effort: null });
  assert.deepEqual(splitStoredModel(null), { baseId: "", effort: null });
  assert.equal(composeModelId("", "high"), "", "no model means no wire value");
});

test("a model name containing brackets is not truncated", () => {
  assert.deepEqual(splitStoredModel("weird["), {
    baseId: "weird[",
    effort: null,
  });
  assert.deepEqual(splitStoredModel("[high]"), {
    baseId: "[high]",
    effort: null,
  });
});
