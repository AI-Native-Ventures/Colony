import assert from "node:assert/strict";
import test from "node:test";

import { buildNavigationCommands } from "./navigationCommands.ts";

const target = () => undefined;

function targets(overrides = {}) {
  return {
    createAgent: target,
    createChannel: target,
    goAgents: target,
    goBlocks: target,
    goDiscovery: target,
    goHome: target,
    goNewMessage: target,
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
      "open-agents",
      "new-message",
      "browse-channels",
      "open-settings",
      "create-channel",
      "create-agent",
      "open-blocks",
      "open-spend",
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
      goSettings: () => calls.push("settings"),
    }),
  );

  commands.find((command) => command.id === "open-settings")?.onSelect();
  assert.deepEqual(calls, ["settings"]);
});
