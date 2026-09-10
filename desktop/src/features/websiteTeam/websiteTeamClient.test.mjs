import assert from "node:assert/strict";
import test from "node:test";

import { continueWebsiteTeamInstall } from "./websiteTeamClient.ts";

function installResult(overrides = {}) {
  const personas = ["Avery", "Ren", "Jules", "Vera"].map((name, index) => ({
    personaId: `website-manager-${name.toLowerCase()}`,
    slug: name.toLowerCase(),
    displayName: name,
    roleId: `role-${index}`,
    roleTitle: "role",
    tier: index === 0 ? "leader" : "worker",
    colorIndex: index,
    agentPubkey: String(index + 1).repeat(64),
    agentName: name,
    managerPubkey: index === 0 ? null : "1".repeat(64),
    created: true,
    assignedSkills: [],
  }));
  return {
    relayUrl: "wss://one.example",
    personas,
    ...overrides,
  };
}

function deps(overrides = {}) {
  const attached = [];
  return {
    attached,
    getRelayWsUrl: async () => "wss://one.example",
    listManagedAgents: async () =>
      ["1", "2", "3", "4"].map((digit) => ({
        pubkey: digit.repeat(64),
        name: `agent-${digit}`,
      })),
    attachAgent: async (channelId, agent) => {
      attached.push({ channelId, pubkey: agent.pubkey });
      return { started: true, membershipAdded: true };
    },
    ...overrides,
  };
}

test("refuses a channel-less call", async () => {
  await assert.rejects(
    () => continueWebsiteTeamInstall(installResult(), "  ", deps()),
    /Choose a channel/,
  );
});

test("refuses to attach after a community switch, before any mutation", async () => {
  const injected = deps({
    getRelayWsUrl: async () => "wss://two.example",
  });
  await assert.rejects(
    () => continueWebsiteTeamInstall(installResult(), "channel-1", injected),
    /different community/,
  );
  assert.equal(injected.attached.length, 0);
});

test("attaches and starts every teammate in order", async () => {
  const injected = deps();
  const outcomes = await continueWebsiteTeamInstall(
    installResult(),
    "channel-1",
    injected,
  );
  assert.equal(outcomes.length, 4);
  assert.ok(outcomes.every((outcome) => outcome.started));
  assert.deepEqual(
    injected.attached.map((entry) => entry.channelId),
    ["channel-1", "channel-1", "channel-1", "channel-1"],
  );
});

test("a start failure isolates to one teammate and reports configuration need", async () => {
  const injected = deps({
    attachAgent: async (_channelId, agent) => {
      if (agent.pubkey.startsWith("2")) {
        throw new Error("Agent readiness failed: no provider configured");
      }
      return { started: true, membershipAdded: true };
    },
  });
  const outcomes = await continueWebsiteTeamInstall(
    installResult(),
    "channel-1",
    injected,
  );
  const failed = outcomes.filter((outcome) => !outcome.started);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].displayName, "Ren");
  assert.equal(failed[0].needsConfiguration, true);
  assert.equal(outcomes.filter((outcome) => outcome.started).length, 3);
});

test("a missing managed-agent row is reported without stopping the others", async () => {
  const injected = deps({
    listManagedAgents: async () => [{ pubkey: "1".repeat(64), name: "avery" }],
  });
  const outcomes = await continueWebsiteTeamInstall(
    installResult(),
    "channel-1",
    injected,
  );
  assert.equal(outcomes[0].started, true);
  assert.match(outcomes[1].error ?? "", /not in this community's agent list/);
  assert.equal(outcomes[1].needsConfiguration, false);
});

test("retry is idempotent: attaching again never creates anything new", async () => {
  const injected = deps();
  await continueWebsiteTeamInstall(installResult(), "channel-1", injected);
  await continueWebsiteTeamInstall(installResult(), "channel-1", injected);
  assert.equal(injected.attached.length, 8);
});
