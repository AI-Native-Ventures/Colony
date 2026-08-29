import assert from "node:assert/strict";
import test from "node:test";

import { actionCenterSourceDestination } from "./actionCenterNavigation.ts";

function pingItem(overrides = {}) {
  return {
    id: "ping:ping-1",
    kind: "ping",
    state: "needs-action",
    title: "asked in #general",
    summary: "hey @owner can you take a look",
    createdAt: 500,
    updatedAt: 500,
    capabilities: ["dismiss", "open-source"],
    source: {
      kind: "ping",
      ping: {
        id: "ping-1",
        channelId: "channel-1",
        channelName: "general",
        threadId: "root-1",
        createdAt: 500,
        content: "hey @owner can you take a look",
      },
    },
    ...overrides,
  };
}

test("a ping's destination navigates to the ping message itself, with the resolved thread root for context", () => {
  const destination = actionCenterSourceDestination(pingItem());
  assert.deepEqual(destination, {
    channelId: "channel-1",
    messageId: "ping-1",
    threadRootId: "root-1",
  });
});
