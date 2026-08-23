import assert from "node:assert/strict";
import test from "node:test";

import {
  agentAiConfigurationModeSatisfied,
  agentAiConfigurationPairForMode,
  agentAiConfigurationStateForMode,
  initialAgentAiConfigurationMode,
} from "./agentAiConfigurationPolicy.ts";

test("existing one-sided and complete overrides open in Customize", () => {
  assert.equal(
    initialAgentAiConfigurationMode({ provider: "anthropic" }),
    "custom",
  );
  assert.equal(
    initialAgentAiConfigurationMode({ model: "claude-opus" }),
    "custom",
  );
  assert.equal(
    initialAgentAiConfigurationMode({
      provider: "anthropic",
      model: "claude-opus",
    }),
    "custom",
  );
  assert.equal(initialAgentAiConfigurationMode({}), "defaults");
});

test("Customize requires a complete explicit pair", () => {
  assert.equal(
    agentAiConfigurationModeSatisfied("custom", {
      provider: "anthropic",
      model: "",
    }),
    false,
  );
  assert.equal(
    agentAiConfigurationModeSatisfied("custom", {
      provider: "",
      model: "claude-opus",
    }),
    false,
  );
  assert.equal(
    agentAiConfigurationModeSatisfied("custom", {
      provider: "anthropic",
      model: "claude-opus",
    }),
    true,
  );
});

test("Codex/Claude Customize needs only a model, not the hidden provider", () => {
  // needsProviderSelection=false → the intentionally hidden provider must not
  // gate Save (the create/edit "Save stays disabled" regression).
  assert.equal(
    agentAiConfigurationModeSatisfied(
      "custom",
      { provider: "", model: "gpt-5-codex" },
      false,
    ),
    true,
  );
  // Still needs a model even when the provider is hidden.
  assert.equal(
    agentAiConfigurationModeSatisfied(
      "custom",
      { provider: "", model: "" },
      false,
    ),
    false,
  );
});

test("Colony Agent/Goose Customize still requires both provider and model", () => {
  assert.equal(
    agentAiConfigurationModeSatisfied(
      "custom",
      { provider: "", model: "llama" },
      true,
    ),
    false,
  );
  assert.equal(
    agentAiConfigurationModeSatisfied(
      "custom",
      { provider: "databricks_v2", model: "llama" },
      true,
    ),
    true,
  );
});

test("runtime-less editable definition still requires the visible provider", () => {
  // A legacy/builtin definition with no runtime but a saved model exposes the
  // provider picker (runtimeCanChooseLlmProvider === true), so the dialog passes
  // needsProviderSelection=true here. An empty provider must NOT satisfy the
  // pair — otherwise Save persists `provider: undefined` despite the visible
  // picker (wesbillman's blocking review point).
  assert.equal(
    agentAiConfigurationModeSatisfied(
      "custom",
      { provider: "", model: "claude-opus-4-5" },
      true,
    ),
    false,
  );
  assert.equal(
    agentAiConfigurationModeSatisfied(
      "custom",
      { provider: "anthropic", model: "claude-opus-4-5" },
      true,
    ),
    true,
  );
});

test("Defaults clears provider and model together", () => {
  assert.deepEqual(
    agentAiConfigurationPairForMode({
      current: { provider: "anthropic", model: "claude-opus" },
      inherited: { provider: "databricks_v2", model: "llama" },
      mode: "defaults",
    }),
    { provider: "", model: "" },
  );
});

test("entering Customize pins only the harness model without a provider picker", () => {
  for (const model of ["claude-opus", "gpt-5.2-codex"]) {
    assert.deepEqual(
      agentAiConfigurationPairForMode({
        current: { provider: "", model: "" },
        inherited: { provider: "databricks_v2", model },
        mode: "custom",
        needsProviderSelection: false,
      }),
      { provider: "", model },
    );
  }
});

test("entering Customize pins unresolved fields from the inherited pair", () => {
  assert.deepEqual(
    agentAiConfigurationPairForMode({
      current: { provider: "anthropic", model: "" },
      inherited: { provider: "databricks_v2", model: "llama" },
      mode: "custom",
    }),
    { provider: "anthropic", model: "llama" },
  );
});

// ── S1: the one toggle owns harness + provider + model together ──

test("a pinned harness alone opens the dialog in Customize", () => {
  // The toggle owns all four fields together, so a harness pin with no
  // provider/model is still an explicit customization.
  assert.equal(initialAgentAiConfigurationMode({ runtime: "codex" }), "custom");
  assert.equal(
    initialAgentAiConfigurationMode({ provider: "", model: "", runtime: "" }),
    "defaults",
  );
});

test("Use agent defaults clears harness, provider, and model together", () => {
  assert.deepEqual(
    agentAiConfigurationStateForMode({
      current: {
        runtime: "codex",
        provider: "anthropic",
        model: "claude-opus",
      },
      inherited: {
        provider: "databricks_v2",
        model: "llama",
        runtimeId: "omp",
      },
      mode: "defaults",
    }),
    { runtime: "", provider: "", model: "" },
  );
});

test("Customize pins the harness, seeding from the inherited default when blank", () => {
  assert.deepEqual(
    agentAiConfigurationStateForMode({
      current: { runtime: "", provider: "", model: "" },
      inherited: {
        provider: "databricks_v2",
        model: "llama",
        runtimeId: "omp",
      },
      mode: "custom",
    }),
    { runtime: "omp", provider: "databricks_v2", model: "llama" },
  );
  // An explicit selection always survives.
  assert.equal(
    agentAiConfigurationStateForMode({
      current: { runtime: "codex", provider: "", model: "" },
      inherited: { provider: "", model: "", runtimeId: "omp" },
      mode: "custom",
    }).runtime,
    "codex",
  );
});
