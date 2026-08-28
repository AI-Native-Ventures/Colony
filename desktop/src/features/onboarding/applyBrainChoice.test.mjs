import assert from "node:assert/strict";
import { test } from "node:test";

import { applyBrainChoice, planBrainConfig } from "./applyBrainChoice.ts";

const BYOK = {
  credential_mode: "byok",
  env_vars: {},
  provider: null,
  model: null,
  preferred_runtime: "oh-my-pi",
};

function runtime(id, label, overrides = {}) {
  return {
    id,
    label,
    avatarUrl: "",
    availability: "available",
    command: null,
    binaryPath: null,
    defaultArgs: [],
    mcpCommand: null,
    installHint: "",
    installInstructionsUrl: "",
    canAutoInstall: false,
    underlyingCliPath: null,
    nodeRequired: false,
    authStatus: { status: "not_applicable" },
    source: "builtin",
    ...overrides,
  };
}

const CATALOG = [
  runtime("claude-code", "Claude Code"),
  runtime("oh-my-pi", "Oh My Pi"),
  runtime("buzz-agent", "Colony Agent"),
];

// The regression: onboarding recorded the choice and the workspace still
// started agents on whatever the defaults already said.
test("a picked CLI runtime becomes the preferred runtime", () => {
  const next = planBrainConfig(CATALOG, BYOK, "Claude Code");
  assert.equal(next?.preferred_runtime, "claude-code");
  assert.equal(next?.credential_mode, "byok");
});

test("ids work as well as labels", () => {
  assert.equal(
    planBrainConfig(CATALOG, BYOK, "claude-code")?.preferred_runtime,
    "claude-code",
  );
});

test("choosing Colony switches to credits and the bundled agent", () => {
  const next = planBrainConfig(CATALOG, BYOK, "colony");
  assert.equal(next?.credential_mode, "colony_credits");
  assert.equal(next?.preferred_runtime, "buzz-agent");
});

// A wrong preferred_runtime is a workspace whose agents cannot start, so an
// unrecognised answer must write nothing at all.
test("an unknown brain writes nothing", () => {
  assert.equal(planBrainConfig(CATALOG, BYOK, "Something Else"), null);
  assert.equal(planBrainConfig(CATALOG, BYOK, ""), null);
  assert.equal(planBrainConfig(CATALOG, BYOK, null), null);
});

test("applying saves exactly the planned config", async () => {
  const saved = [];
  const next = await applyBrainChoice("Claude Code", {
    listRuntimes: async () => CATALOG,
    loadConfig: async () => BYOK,
    saveConfig: async (config) => saved.push(config),
  });
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], next);
  assert.equal(saved[0].preferred_runtime, "claude-code");
});

test("applying an unknown brain saves nothing", async () => {
  const saved = [];
  const next = await applyBrainChoice("Nope", {
    listRuntimes: async () => CATALOG,
    loadConfig: async () => BYOK,
    saveConfig: async (config) => saved.push(config),
  });
  assert.equal(next, null);
  assert.deepEqual(saved, []);
});
