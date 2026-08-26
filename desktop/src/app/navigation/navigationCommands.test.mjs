import assert from "node:assert/strict";
import test from "node:test";

import { buildNavigationCommands } from "./navigationCommands.ts";

const target = () => undefined;

function targets(overrides = {}) {
  return {
    createAgent: target,
    createChannel: target,
    goActionCenter: target,
    goAgents: target,
    goBlocksSettings: target,
    goCredits: target,
    goDiscovery: target,
    goHome: target,
    goNewMessage: target,
    goPeople: target,
    goProjects: target,
    goPulse: target,
    goSettings: target,
    goSpend: target,
    goWorkflows: target,
    openBrowseChannels: target,
    projectsEnabled: true,
    pulseEnabled: true,
    workflowsEnabled: true,
    ...overrides,
  };
}

test("buildNavigationCommands includes enabled destinations", () => {
  assert.deepEqual(
    buildNavigationCommands(targets()).map((command) => command.id),
    [
      "open-home",
      "open-action-center",
      "open-agents",
      "open-people",
      "new-message",
      "browse-channels",
      "open-settings",
      "create-channel",
      "create-agent",
      "open-blocks",
      "open-spend",
      "open-credits",
      "open-discovery",
      "open-pulse",
      "open-projects",
      "open-workflows",
    ],
  );
});

test("buildNavigationCommands omits disabled preview destinations", () => {
  const commands = buildNavigationCommands(
    targets({
      pulseEnabled: false,
      projectsEnabled: false,
      workflowsEnabled: false,
    }),
  );

  assert.equal(
    commands.some((command) => command.id === "open-pulse"),
    false,
  );
  assert.equal(
    commands.some((command) => command.id === "open-projects"),
    false,
  );
  assert.equal(
    commands.some((command) => command.id === "open-workflows"),
    false,
  );
});

test("command callbacks delegate to their navigation targets", () => {
  const calls = [];
  const commands = buildNavigationCommands(
    targets({
      goActionCenter: () => calls.push("action-center"),
      goCredits: () => calls.push("credits"),
      goSettings: () => calls.push("settings"),
    }),
  );

  commands.find((command) => command.id === "open-settings")?.onSelect();
  commands.find((command) => command.id === "open-action-center")?.onSelect();
  commands.find((command) => command.id === "open-credits")?.onSelect();
  assert.deepEqual(calls, ["settings", "action-center", "credits"]);
});
