import assert from "node:assert/strict";
import { mock, test } from "node:test";

const RELAY = "wss://synthetic-business.example.test";
const PROVISIONED = "c".repeat(64);

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

/** Call order across the two commands, which is the thing under test. */
const calls = [];
const creates = [];
/** Records the backend holds. Adoption is what puts the provisioned one here. */
let stored = [];

const provisionedChief = {
  pubkey: PROVISIONED,
  personaId: null,
  provisioned: "chief-of-staff",
  teamId: null,
  relayUrl: RELAY,
  name: "Chief of Staff",
  status: "stopped",
  backend: { type: "local" },
  runtime: null,
  agentCommand: "claude-agent-acp",
  agentCommandOverride: null,
  agentArgs: [],
  model: null,
  provider: null,
};

mock.module("@/shared/api/tauri", {
  namedExports: {
    adoptProvisionedEmployees: async () => {
      calls.push("adopt");
      // Adoption is what writes the record, exactly as the real command does.
      stored = [provisionedChief];
      return [
        {
          outcome: "adopted",
          handle: "chief-of-staff",
          name: "Chief of Staff",
          pubkey: PROVISIONED,
        },
      ];
    },
    listManagedAgents: async () => {
      calls.push("list");
      return stored;
    },
    discoverAcpRuntimes: async () => [],
    getChannelMembers: async () => [],
    addChannelMembers: async (input) => {
      calls.push(`members:${input.pubkeys.join(",")}`);
      return { errors: [] };
    },
    createManagedAgent: async (input) => {
      creates.push(input);
      throw new Error("the welcome flow must not mint a second Chief of Staff");
    },
  },
});
mock.module("@/shared/api/tauriGlobalAgentConfig", {
  namedExports: {
    getGlobalAgentConfig: async () => ({ preferred_runtime: null }),
  },
});
mock.module("@/shared/api/tauriPersonas", {
  namedExports: {
    listPersonas: async () => [persona],
    setPersonaActive: async () => {},
  },
});

test("a community with Colony's provisioned employee never mints a built-in Chief of Staff", async () => {
  const { ensureWelcomeTeam } = await import("./welcomeGuide.ts");
  const { agents } = await ensureWelcomeTeam("synthetic-channel", RELAY);

  assert.deepEqual(creates, [], "no built-in instance may be created");
  assert.equal(agents.length, 1);
  assert.equal(agents[0].pubkey, PROVISIONED);
  // Ordering is the whole point: adoption has to have had its chance before
  // the roster is read, or a fresh community mints `builtin:fizz` seconds
  // before the provisioned record lands and the duplicate is back.
  assert.equal(calls[0], "adopt");
  assert.equal(calls[1], "list");
  assert.ok(
    calls.includes(`members:${PROVISIONED}`),
    "the provisioned employee still joins the Welcome channel",
  );
});
