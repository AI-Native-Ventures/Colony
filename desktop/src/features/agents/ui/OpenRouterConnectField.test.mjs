/**
 * Tests for the OpenRouter connect helpers: the key merge/removal must only
 * ever touch `env_vars.OPENROUTER_API_KEY` and must preserve every other
 * config field and env var — prior credentials and unrelated settings stay
 * intact through connect, disconnect, and reconnect.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENROUTER_API_KEY,
  withOpenRouterKey,
  withoutOpenRouterKey,
} from "./OpenRouterConnectField.tsx";

const baseConfig = {
  env_vars: {
    ANTHROPIC_API_KEY: "sk-ant-kept",
    OPENROUTER_API_KEY: "sk-or-old",
    OTHER_VAR: "kept",
  },
  provider: "openrouter",
  model: "some/model",
  preferred_runtime: "buzz-agent",
};

test("withOpenRouterKey stores the key and preserves everything else", () => {
  const next = withOpenRouterKey(baseConfig, "sk-or-new");
  assert.equal(next.env_vars[OPENROUTER_API_KEY], "sk-or-new");
  assert.equal(next.env_vars.ANTHROPIC_API_KEY, "sk-ant-kept");
  assert.equal(next.env_vars.OTHER_VAR, "kept");
  assert.equal(next.provider, "openrouter");
  assert.equal(next.model, "some/model");
  assert.equal(next.preferred_runtime, "buzz-agent");
  // The input config is not mutated.
  assert.equal(baseConfig.env_vars[OPENROUTER_API_KEY], "sk-or-old");
});

test("withOpenRouterKey on a config with no key adds only the key", () => {
  const bare = {
    env_vars: { OTHER_VAR: "kept" },
    provider: null,
    model: null,
    preferred_runtime: null,
  };
  const next = withOpenRouterKey(bare, "sk-or-new");
  assert.deepEqual(next.env_vars, {
    OTHER_VAR: "kept",
    OPENROUTER_API_KEY: "sk-or-new",
  });
});

test("withoutOpenRouterKey removes only the OpenRouter key", () => {
  const next = withoutOpenRouterKey(baseConfig);
  assert.equal(OPENROUTER_API_KEY in next.env_vars, false);
  assert.deepEqual(next.env_vars, {
    ANTHROPIC_API_KEY: "sk-ant-kept",
    OTHER_VAR: "kept",
  });
  assert.equal(next.provider, "openrouter");
});

test("withoutOpenRouterKey is a no-op when no key is present", () => {
  const bare = {
    env_vars: { OTHER_VAR: "kept" },
    provider: null,
    model: null,
    preferred_runtime: null,
  };
  assert.deepEqual(withoutOpenRouterKey(bare), bare);
});
