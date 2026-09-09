import assert from "node:assert/strict";
import test from "node:test";
import {
  configForPowerLane,
  initialPowerConfig,
  isFreeOpenRouterModel,
  powerLaneForConfig,
} from "./powerChoice.ts";
const current = {
  credential_mode: "byok",
  preferred_runtime: "buzz-agent",
  provider: "openrouter",
  model: "vendor/paid",
  env_vars: {
    OPENROUTER_API_KEY: "synthetic",
    BUZZ_AGENT_MODEL: "paid-override",
    OPENROUTER_BASE_URL: "https://custom.example.test",
  },
};
test("existing paid or API-key setup is not silently moved to a different payment route", () => {
  assert.equal(powerLaneForConfig(current), "existing");
  assert.equal(configForPowerLane(current, "existing"), current);
});
test("opening power preserves configured defaults without a runtime pin", () => {
  for (const config of [
    { ...current, preferred_runtime: null },
    {
      ...current,
      preferred_runtime: null,
      credential_mode: "colony_credits",
      provider: "openai-compat",
      model: "already-selected-model",
    },
  ]) {
    assert.equal(initialPowerConfig(config), config);
  }
});
test("explicit free choice clears a paid model and vendor endpoint override", () => {
  const selected = configForPowerLane(current, "openrouter");
  assert.equal(selected.model, "openrouter/free");
  assert.equal(selected.env_vars.BUZZ_AGENT_MODEL, undefined);
  assert.equal(selected.env_vars.OPENROUTER_BASE_URL, undefined);
  assert.equal(selected.env_vars.OPENROUTER_API_KEY, "synthetic");
  assert.equal(current.model, "vendor/paid");
});
test("free model contract refuses paid routing variants", () => {
  for (const id of ["openrouter/free", "vendor/model:free"])
    assert.equal(isFreeOpenRouterModel(id), true);
  for (const id of [null, "", "vendor/model", "vendor/model:free:nitro"])
    assert.equal(isFreeOpenRouterModel(id), false);
});
test("subscription is an explicit choice and clears inherited vendor model pins", () => {
  const selected = configForPowerLane(current, "subscription", "codex");
  assert.equal(selected.preferred_runtime, "codex");
  assert.equal(selected.model, null);
  assert.equal(selected.provider, null);
  assert.equal(selected.credential_mode, "byok");
});

test("only the supported subscription runtimes use connection validation, even with inherited provider fields", () => {
  for (const runtime of ["claude", "codex"]) {
    for (const provider of [null, "anthropic", "openrouter"]) {
      const config = { ...current, preferred_runtime: runtime, provider };
      assert.equal(powerLaneForConfig(config), "subscription");
      assert.equal(initialPowerConfig(config), config);
    }
  }
});

test("other runtimes keep their provider, model and credentials as an existing setup", () => {
  for (const runtime of ["omp", "opencode", "goose", "custom-runtime"]) {
    for (const provider of [null, "anthropic", "openrouter"]) {
      const config = {
        ...current,
        preferred_runtime: runtime,
        provider,
        model: "vendor/model:free",
      };
      assert.equal(powerLaneForConfig(config), "existing");
      assert.equal(initialPowerConfig(config), config);
      assert.equal(configForPowerLane(config, "existing"), config);
    }
  }
});
