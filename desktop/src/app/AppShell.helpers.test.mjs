import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveShellRoute,
  markAllReadSources,
  shouldBounceForChannelNotification,
} from "./AppShell.helpers.ts";

test("shouldBounceForChannelNotification_allowsTopLevelChannelMessages", () => {
  assert.equal(shouldBounceForChannelNotification([["h", "channel"]]), true);
});

test("shouldBounceForChannelNotification_suppressesThreadReplies", () => {
  assert.equal(
    shouldBounceForChannelNotification([
      ["h", "channel"],
      ["e", "root", "", "reply"],
    ]),
    false,
  );
});

test("shouldBounceForChannelNotification_allowsBroadcastReplies", () => {
  assert.equal(
    shouldBounceForChannelNotification([
      ["h", "channel"],
      ["e", "root", "", "reply"],
      ["broadcast", "1"],
    ]),
    true,
  );
});

test("markAllReadSources clears Inbox overrides and active thread activity", () => {
  const calls = [];

  markAllReadSources({
    activeChannelId: "active-channel",
    channelActivityItems: [
      { channelId: "another-channel", createdAt: 100 },
      { channelId: "active-channel", createdAt: 200 },
      { channelId: "active-channel", createdAt: 300 },
    ],
    unreadFeedItemIds: new Set(["first-inbox-item", "second-inbox-item"]),
    undoUnreadFeedItem: (itemId) => calls.push(`inbox:${itemId}`),
    markAllChannelReadMarkers: () => calls.push("channels"),
    markActiveChannelRead: (channelId, createdAt) =>
      calls.push(`active:${channelId}:${createdAt}`),
  });

  assert.deepEqual(calls, [
    "inbox:first-inbox-item",
    "inbox:second-inbox-item",
    "channels",
    "active:active-channel:300",
  ]);
});

test("markAllReadSources skips the active marker without projected activity", () => {
  const calls = [];

  markAllReadSources({
    activeChannelId: "active-channel",
    channelActivityItems: [],
    unreadFeedItemIds: new Set(),
    undoUnreadFeedItem: () => calls.push("inbox"),
    markAllChannelReadMarkers: () => calls.push("channels"),
    markActiveChannelRead: () => calls.push("active"),
  });

  assert.deepEqual(calls, ["channels"]);
});
test("action center route derives the Action Center sidebar selection", () => {
  assert.deepEqual(deriveShellRoute("/action-center?filter=all&item=ask:1"), {
    selectedChannelId: null,
    selectedView: "action-center",
  });
});

test("work route derives the Work sidebar selection", () => {
  assert.deepEqual(deriveShellRoute("/work"), {
    selectedChannelId: null,
    selectedView: "work",
  });
});

test("agents route derives the Agents sidebar selection", () => {
  assert.deepEqual(deriveShellRoute("/agents"), {
    selectedChannelId: null,
    selectedView: "agents",
  });
});

test("credits route derives the Credits sidebar selection", () => {
  assert.deepEqual(deriveShellRoute("/credits"), {
    selectedChannelId: null,
    selectedView: "credits",
  });
});

test("section params stay on the Agents selection", () => {
  assert.deepEqual(deriveShellRoute("/agents?section=people"), {
    selectedChannelId: null,
    selectedView: "agents",
  });
  assert.deepEqual(deriveShellRoute("/agents?section=teams"), {
    selectedChannelId: null,
    selectedView: "agents",
  });
});
