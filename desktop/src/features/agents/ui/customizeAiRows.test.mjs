import assert from "node:assert/strict";
import test from "node:test";

import {
  customizeAiHasOverrides,
  customizeAiRowCustomFlags,
  providerKeyNote,
  rowDisplayValue,
  rowIsCustom,
} from "./customizeAiRows.lib.ts";

/** An agent that just switched to Customize: every row copied from defaults. */
function inheritedValues(overrides = {}) {
  return {
    fallbacks: { authored: false },
    harness: { current: "buzz-agent", inherited: "buzz-agent" },
    model: {
      current: "cohere/north-mini-code:free",
      inherited: "cohere/north-mini-code:free",
    },
    provider: {
      current: "openrouter",
      inherited: "openrouter",
      visible: true,
    },
    reasoning: { current: "xhigh", inherited: "xhigh" },
    ...overrides,
  };
}

test("switching to Customize marks every row inherited", () => {
  assert.deepEqual(customizeAiRowCustomFlags(inheritedValues()), {
    fallbacks: false,
    harness: false,
    model: false,
    provider: false,
    reasoning: false,
  });
  assert.equal(customizeAiHasOverrides(inheritedValues()), false);
});

test("a row turns custom only once its value leaves the inherited one", () => {
  const changed = inheritedValues({
    model: {
      current: "thinkingmachines/inkling:free",
      inherited: "cohere/north-mini-code:free",
    },
  });
  assert.equal(customizeAiRowCustomFlags(changed).model, true);
  assert.equal(customizeAiRowCustomFlags(changed).provider, false);
  assert.equal(customizeAiHasOverrides(changed), true);
});

test("Reset returns a row to inherited, and the tab to no overrides", () => {
  const changed = inheritedValues({
    reasoning: { current: "low", inherited: "xhigh" },
  });
  assert.equal(customizeAiHasOverrides(changed), true);
  const afterReset = inheritedValues({
    reasoning: { current: "xhigh", inherited: "xhigh" },
  });
  assert.equal(customizeAiHasOverrides(afterReset), false);
});

test("an authored fallback chain is an override on its own", () => {
  assert.equal(
    customizeAiHasOverrides(inheritedValues({ fallbacks: { authored: true } })),
    true,
  );
});

test("a hidden provider row can never count as overridden", () => {
  // Codex and Claude drive their own provider, so the row is not rendered and
  // whatever the draft carries there must not make the tab look customized.
  const hidden = inheritedValues({
    provider: { current: "anthropic", inherited: "", visible: false },
  });
  assert.equal(customizeAiRowCustomFlags(hidden).provider, false);
  assert.equal(customizeAiHasOverrides(hidden), false);
});

test("values that differ only by whitespace still read as inherited", () => {
  assert.equal(rowIsCustom("  openrouter ", "openrouter"), false);
  assert.equal(rowIsCustom("openai", "openrouter"), true);
});

test("the Provider row says where its key comes from", () => {
  assert.equal(
    providerKeyNote({ isInherited: true, isRequired: false }),
    "Key: from defaults",
  );
  assert.equal(
    providerKeyNote({ isInherited: false, isRequired: false }),
    "Key: set for this agent",
  );
  // A key no layer supplies is not a preference: it is what stops the agent
  // from running, so the row says so and opens the input on its own.
  assert.equal(
    providerKeyNote({ isInherited: false, isRequired: true }),
    "Key: needed",
  );
});

test("a row with no value of its own displays what it inherits", () => {
  assert.equal(rowDisplayValue("", "openrouter"), "openrouter");
  assert.equal(rowDisplayValue("openai", "openrouter"), "openai");
  assert.equal(rowDisplayValue("", "", "Harness default"), "Harness default");
});
