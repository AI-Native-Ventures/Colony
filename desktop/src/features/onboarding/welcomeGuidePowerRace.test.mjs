import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";

const PUBKEY = "a".repeat(64);
const RELAY = "wss://synthetic-business.example.test";
const persona = {
  id: "builtin:fizz",
  displayName: "Scout",
  systemPrompt: "Coordinate the work.",
  runtime: null,
  model: null,
  provider: null,
  avatarUrl: null,
  envVars: {},
  isActive: true,
};
const runtimes = ["buzz-agent", "claude", "codex"].map((id) => ({
  id,
  label: id,
  availability: "available",
  command:
    id === "claude" ? "claude-agent-acp" : id === "codex" ? "codex-acp" : id,
  defaultArgs: [],
  mcpCommand: id === "claude" ? null : "buzz-dev-mcp",
}));
let agents, creates, updates, globalConfig, created, release;
let creationStarted, creationGate;
const agent = (overrides = {}) => ({
  pubkey: PUBKEY,
  personaId: "builtin:fizz",
  teamId: "builtin-team:welcome",
  relayUrl: RELAY,
  name: "Scout",
  status: "stopped",
  backend: { type: "local" },
  runtime: null,
  agentCommand: "claude-agent-acp",
  agentCommandOverride: null,
  agentArgs: [],
  model: "old-summary-model",
  provider: "old-summary-provider",
  ...overrides,
});
mock.module("@/shared/api/tauri", {
  namedExports: {
    listManagedAgents: async () => agents,
    discoverAcpRuntimes: async () => runtimes,
    getChannelMembers: async () => [],
    addChannelMembers: async () => ({ errors: [] }),
    createManagedAgent: async (input) => {
      creates.push(input);
      created();
      await creationGate;
      return { agent: agent() };
    },
    updateManagedAgent: async (input) => {
      updates.push(input);
      throw new Error("Onboarding must not rewrite existing configuration");
    },
  },
});
mock.module("@/shared/api/tauriGlobalAgentConfig", {
  namedExports: {
    getGlobalAgentConfig: async () => ({ ...globalConfig }),
  },
});
mock.module("@/shared/api/tauriPersonas", {
  namedExports: {
    listPersonas: async () => [persona],
    setPersonaActive: async () => {},
  },
});
beforeEach(() => {
  agents = [];
  creates = [];
  updates = [];
  globalConfig = {
    preferred_runtime: "claude",
    model: "old-model",
    provider: "anthropic",
  };
  creationStarted = new Promise((resolve) => {
    created = resolve;
  });
  creationGate = new Promise((resolve) => {
    release = resolve;
  });
});

test("a background Welcome create captured before Power cannot pin the former runtime", {
  timeout: 5_000,
}, async () => {
  const { ensureWelcomeTeam } = await import("./welcomeGuide.ts");
  const first = ensureWelcomeTeam("synthetic-channel", RELAY);
  await creationStarted;
  assert.equal(
    creates[0].agentCommand,
    "claude-agent-acp",
    "fixture must capture the previous Power setting",
  );
  globalConfig = {
    preferred_runtime: "buzz-agent",
    provider: "openrouter",
    model: "synthetic:free",
  };
  const afterPower = ensureWelcomeTeam("synthetic-channel", RELAY);
  assert.equal(
    afterPower,
    first,
    "exercise the actual in-flight seed deduplication",
  );
  release();
  await Promise.all([first, afterPower]);
  assert.equal(creates.length, 1);
  assert.equal(
    creates[0].harnessOverride,
    false,
    "native create must not persist the captured command as a pin",
  );
  assert.equal(creates[0].model, undefined);
  assert.equal(creates[0].provider, undefined);
  assert.deepEqual(creates[0].agentArgs, []);
  assert.equal(creates[0].mcpCommand, "");
  assert.deepEqual(updates, []);
});

test("repeated Welcome setup leaves a defaults-mode Scout on live defaults without writing a pin", async () => {
  const { ensureWelcomeTeam } = await import("./welcomeGuide.ts");
  const existing = agent();
  agents = [existing];
  globalConfig = {
    preferred_runtime: "buzz-agent",
    provider: "openrouter",
    model: "synthetic:free",
  };
  const result = await ensureWelcomeTeam("defaults-channel", RELAY);
  assert.equal(result.agents[0], existing);
  assert.deepEqual(creates, []);
  assert.deepEqual(updates, []);
  assert.equal(existing.agentCommandOverride, null);
  assert.equal(existing.runtime, null);
});

test("Welcome setup preserves existing manual command, runtime, model and arguments", async () => {
  const { ensureWelcomeTeam } = await import("./welcomeGuide.ts");
  for (const overrides of [
    {
      agentCommandOverride: "/synthetic/custom-agent",
      agentArgs: ["--owner-choice"],
    },
    { runtime: "codex", agentArgs: ["--owner-choice"] },
  ]) {
    const existing = agent(overrides);
    const before = structuredClone(existing);
    agents = [existing];
    const result = await ensureWelcomeTeam("manual-channel", RELAY);
    assert.equal(result.agents[0], existing);
    assert.deepEqual(existing, before);
  }
  assert.deepEqual(creates, []);
  assert.deepEqual(updates, []);
});
