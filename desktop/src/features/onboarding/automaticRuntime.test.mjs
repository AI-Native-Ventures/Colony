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
  assert.deepEqual(defaultColonyAgentConfig(), {
    credential_mode: "colony_credits",
    env_vars: { OPENAI_COMPAT_BASE_URL: "https://api.deepseek.com" },
    provider: "deepseek",
    model: "deepseek-v4-flash",
    preferred_runtime: "buzz-agent",
  });
});
