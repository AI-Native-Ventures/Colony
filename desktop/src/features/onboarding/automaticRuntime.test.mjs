import assert from "node:assert/strict";
import test from "node:test";

import {
  configForAutomaticCli,
  defaultColonyAgentConfig,
  selectAutomaticRuntime,
} from "./automaticRuntime.ts";

function runtime(id, availability = "available", authStatus = "logged_in") {
  return {
    id,
    availability,
    authStatus: { status: authStatus },
  };
}

const emptyConfig = {
  credential_mode: "byok",
  env_vars: {},
  provider: null,
  model: null,
  preferred_runtime: null,
};

test("a usable supported CLI is selected without exposing a chooser", () => {
  assert.deepEqual(
    selectAutomaticRuntime([runtime("claude"), runtime("codex")]),
    { route: "cli", runtimeId: "codex" },
  );
  assert.deepEqual(configForAutomaticCli(emptyConfig, "codex"), {
    ...emptyConfig,
    preferred_runtime: "codex",
  });
});

test("a merely installed but logged-out CLI does not count as usable", () => {
  assert.deepEqual(
    selectAutomaticRuntime([runtime("codex", "available", "logged_out")]),
    {
      route: "colony-agent",
      runtimeId: "buzz-agent",
    },
  );
});

test("the Colony Agent branch preselects Colony Credits and DeepSeek V4 Flash", () => {
  // The provider is the OpenAI-compatible dialect the relay gateway speaks,
  // not the vendor name: Colony Credits refuses `deepseek` on this runtime at
  // spawn, so the model is DeepSeek's while the dialect is not. No vendor base
  // URL either, for the same reason.
  assert.deepEqual(defaultColonyAgentConfig(), {
    credential_mode: "colony_credits",
    env_vars: {},
    provider: "openai-compat",
    model: "deepseek-v4-flash",
    preferred_runtime: "buzz-agent",
  });
});

test("a saved vendor base URL never survives into the metered config", () => {
  assert.deepEqual(
    defaultColonyAgentConfig({
      credential_mode: "byok",
      env_vars: {
        OPENAI_COMPAT_BASE_URL: "https://api.deepseek.com",
        ANTHROPIC_API_KEY: "kept",
      },
      provider: "deepseek",
      model: "deepseek-chat",
      preferred_runtime: null,
    }).env_vars,
    { ANTHROPIC_API_KEY: "kept" },
  );
});
