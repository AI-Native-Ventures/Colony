import assert from "node:assert/strict";
import test from "node:test";

import { setNativeBridge } from "@/shared/api/nativeBridge";
import { createMockNativeBridge } from "@/testing/createMockNativeBridge";

test("delayed project data does not start home, then starts the linked checkout", async () => {
  const calls = [];
  setNativeBridge(
    createMockNativeBridge(async (command, args) => {
      calls.push({ command, args });
      if (command === "workspace_terminal_start") {
        return {
          sessionId: "project-session",
          cwd: "/workspace/repos/colony",
          pid: 9124,
        };
      }
      return null;
    }),
  );

  const [{ buildTerminalStartRequest }, sessions] = await Promise.all([
    import("./terminalKind.tsx"),
    import("../lib/terminalSessions.ts"),
  ]);
  const channelId = "channel-project";
  const project = {
    id: "project-1",
    dtag: "colony",
    name: "Colony",
    description: "",
    cloneUrls: ["https://example.test/colony.git"],
    webUrl: null,
    owner: "owner",
    contributors: [],
    createdAt: 0,
    projectChannelId: channelId,
    status: "open",
    defaultBranch: "main",
    repoAddress: "30617:owner:colony",
  };

  const pending = buildTerminalStartRequest({
    channelId,
    project: null,
    projectsSettled: false,
    reposDir: "/workspace/repos",
  });
  assert.equal(pending, null);
  assert.equal(
    calls.filter(({ command }) => command === "workspace_terminal_start")
      .length,
    0,
  );

  const settled = buildTerminalStartRequest({
    channelId,
    project,
    projectsSettled: true,
    reposDir: "/workspace/repos",
  });
  assert.deepEqual(settled, {
    channelId,
    projectDtag: "colony",
    cloneUrl: "https://example.test/colony.git",
    reposDir: "/workspace/repos",
    cols: 80,
    rows: 24,
    pixelWidth: 0,
    pixelHeight: 0,
  });
  await sessions.ensureTerminalSession("tab-project", settled);
  assert.equal(
    calls.filter(({ command }) => command === "workspace_terminal_start")
      .length,
    1,
  );
  assert.deepEqual(calls.at(-1), {
    command: "workspace_terminal_start",
    args: { request: settled },
  });
  await sessions.disposeTerminalSession("tab-project");
});
