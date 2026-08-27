import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureAutomaticAgentConfig,
  planAutomaticAgentConfig,
} from "./automaticAgentSetup.ts";
import {
  isOwnerLedCommunityOnboarding,
  startCommunityOnboarding,
} from "./communityOnboarding.tsx";
import { resolveAgentReadiness } from "./ui/agentReadiness.ts";
import { welcomeKickoffOpening } from "./welcomeKickoff.ts";

function runtime(id, availability = "available", authStatus = "logged_in") {
  return { id, label: id, availability, authStatus: { status: authStatus } };
}

const EMPTY_CONFIG = {
  credential_mode: "byok",
  env_vars: {},
  provider: null,
  model: null,
  preferred_runtime: null,
};

/**
 * A machine with nothing installed but the Colony Agent that ships with the
 * app, which is what a brand-new owner's computer looks like.
 */
const CLEAN_MACHINE = [
  runtime("buzz-agent", "available", "not_applicable"),
  runtime("claude", "not_installed", "logged_out"),
  runtime("codex", "not_installed", "logged_out"),
];

const HOSTED_RELAY = {
  self_serve: true,
  domain: "colony.ainative.ventures",
  max_per_owner: 3,
};

function fakeDevice({
  runtimes = CLEAN_MACHINE,
  config = EMPTY_CONFIG,
  relay = HOSTED_RELAY,
} = {}) {
  const device = { config, installed: [], writes: 0 };
  const io = {
    listRuntimes: async () => runtimes,
    loadConfig: async () => device.config,
    saveConfig: async (next) => {
      device.config = next;
      device.writes += 1;
      return { config: next, restartedCount: 0 };
    },
    installRuntime: async (runtimeId) => {
      device.installed.push(runtimeId);
      return { success: true, steps: [] };
    },
    loadProvisioning: async () => {
      if (relay instanceof Error) throw relay;
      return relay;
    },
  };
  return { device, io };
}

function fakeStorage() {
  const entries = new Map();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  };
}

test("a first-run owner reaches Welcome with an agent configured, not a Settings errand", async () => {
  // The regression this exists for: the automatic runtime setup only ever ran
  // for a returning founder creating a second company, so a first-time owner
  // arrived in Welcome on `byok` with no provider and Scout opened with
  // WELCOME_KICKOFF_PROVIDER_MESSAGE instead of introducing the team.
  const transaction = startCommunityOnboarding(
    {
      source: "first-community",
      firstCommunityPage: "owned",
      relayUrl: "wss://acme.colony.ainative.ventures",
    },
    fakeStorage(),
  );
  assert.equal(isOwnerLedCommunityOnboarding(transaction), true);

  const { device, io } = fakeDevice();
  // Before the handoff the machine is unconfigured, and that is exactly the
  // state that produces the Settings errand.
  assert.equal(
    welcomeKickoffOpening(resolveAgentReadiness(CLEAN_MACHINE, device.config)),
    "provider-required",
  );

  const plan = await ensureAutomaticAgentConfig(io);

  // What the new owner is actually handed. "team-intro" is the branch that
  // starts Scout and posts the opener; "provider-required" is the branch that
  // posts WELCOME_KICKOFF_PROVIDER_MESSAGE and stops.
  const readiness = resolveAgentReadiness(CLEAN_MACHINE, device.config);
  assert.equal(welcomeKickoffOpening(readiness), "team-intro");
  assert.equal(readiness.ready, true);

  assert.deepEqual(device.config, {
    credential_mode: "colony_credits",
    env_vars: {},
    provider: "openai-compat",
    model: "deepseek-v4-flash",
    preferred_runtime: "buzz-agent",
  });
  assert.deepEqual(device.installed, ["buzz-agent"]);
  assert.deepEqual(plan, {
    action: "configure",
    route: "colony-agent",
    runtimeId: "buzz-agent",
    config: device.config,
  });
});

test("a hosted config keeps the vendor base URL out of the metered path", async () => {
  // A saved BYOK DeepSeek URL would send a metered agent straight to the
  // vendor carrying a Colony gateway token, which the vendor rejects.
  const { device, io } = fakeDevice({
    config: {
      ...EMPTY_CONFIG,
      env_vars: {
        OPENAI_COMPAT_BASE_URL: "https://api.deepseek.com",
        SOME_OTHER_KEY: "kept",
      },
    },
  });
  await ensureAutomaticAgentConfig(io);
  assert.deepEqual(device.config.env_vars, { SOME_OTHER_KEY: "kept" });
});

test("a relay that does not host agents leaves the machine on BYOK", async () => {
  // Writing colony_credits against a relay with no gateway swaps a Settings
  // errand for an agent that cannot take a turn, which is strictly worse.
  for (const relay of [
    { self_serve: false, domain: null },
    // A relay claiming self-serve without naming a domain cannot mint hosts,
    // the same pair `provisioningFromConfig` refuses for the create form.
    { self_serve: true, domain: null },
    // Too old to answer at all.
    new Error("404"),
  ]) {
    const { device, io } = fakeDevice({ relay });
    assert.deepEqual(await ensureAutomaticAgentConfig(io), {
      action: "skip",
      reason: "relay-has-no-hosted-agent",
    });
    assert.equal(device.writes, 0);
    assert.deepEqual(device.config, EMPTY_CONFIG);
    assert.deepEqual(device.installed, []);
  }
});

test("a machine with a signed-in CLI uses it and never asks the relay", async () => {
  const runtimes = [...CLEAN_MACHINE, runtime("codex")];
  const { device, io } = fakeDevice({
    runtimes,
    relay: new Error("the relay must not be consulted on this route"),
  });
  const plan = await ensureAutomaticAgentConfig(io);
  assert.equal(plan.action, "configure");
  assert.equal(plan.route, "cli");
  assert.deepEqual(device.config, {
    ...EMPTY_CONFIG,
    preferred_runtime: "codex",
  });
  assert.deepEqual(device.installed, []);
});

test("an agent path that already works is never repointed", async () => {
  const configured = {
    ...EMPTY_CONFIG,
    credential_mode: "colony_credits",
    provider: "openai-compat",
    model: "deepseek-v4-flash",
    preferred_runtime: "buzz-agent",
  };
  const { device, io } = fakeDevice({ config: configured });
  assert.deepEqual(await ensureAutomaticAgentConfig(io), {
    action: "skip",
    reason: "already-configured",
  });
  assert.equal(device.writes, 0);
});

test("a machine already on Colony Credits is repaired, not moved to BYOK", async () => {
  // The shape this build no longer writes: `deepseek` is refused by the spawn
  // preflight, so it is not a working path. Onboarding fixes the pair rather
  // than taking a deliberate hosted choice away.
  const { device, io } = fakeDevice({
    runtimes: [...CLEAN_MACHINE, runtime("codex")],
    config: {
      ...EMPTY_CONFIG,
      credential_mode: "colony_credits",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      preferred_runtime: "buzz-agent",
    },
  });
  const plan = await ensureAutomaticAgentConfig(io);
  assert.equal(plan.action, "configure");
  assert.equal(plan.route, "colony-agent");
  assert.equal(device.config.credential_mode, "colony_credits");
  assert.equal(device.config.provider, "openai-compat");
});

test("only an owner-led journey writes this device's agent defaults", () => {
  const storage = fakeStorage();
  const journeys = [
    [{ source: "first-community", firstCommunityPage: "owned" }, true],
    [{ source: "first-community", firstCommunityPage: "join" }, false],
    [{ source: "first-community", firstCommunityPage: "member" }, false],
    [{ source: "create-community" }, true],
    [{ source: "add-community" }, false],
    [{ source: "deep-link-join" }, false],
    [{ source: "membership-recovery" }, false],
  ];
  for (const [input, expected] of journeys) {
    storage.removeItem("buzz-community-onboarding-transaction.v1");
    const transaction = startCommunityOnboarding(
      { ...input, relayUrl: "wss://acme.colony.ainative.ventures" },
      storage,
    );
    assert.equal(
      isOwnerLedCommunityOnboarding(transaction),
      expected,
      JSON.stringify(input),
    );
  }
});

test("a provider Colony Credits cannot serve never reads as ready", () => {
  // Readiness answers the same matrix the spawn preflight enforces, so the
  // hosted config that used to be written (`deepseek`, refused at spawn)
  // cannot pass itself off as a working agent path.
  assert.equal(
    resolveAgentReadiness(CLEAN_MACHINE, {
      ...EMPTY_CONFIG,
      credential_mode: "colony_credits",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      preferred_runtime: "buzz-agent",
    }).ready,
    false,
  );
  // And the planner refuses the hosted route outright when the relay behind
  // this community cannot back it.
  assert.deepEqual(
    planAutomaticAgentConfig(CLEAN_MACHINE, EMPTY_CONFIG, false),
    { action: "skip", reason: "relay-has-no-hosted-agent" },
  );
});
