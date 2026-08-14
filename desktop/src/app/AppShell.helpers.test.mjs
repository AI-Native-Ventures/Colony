import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveShellRoute,
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

test("blocks route derives the Blocks sidebar selection", () => {
  assert.deepEqual(deriveShellRoute("/blocks"), {
    selectedChannelId: null,
    selectedView: "blocks",
  });
});
test("action center route derives the Action Center sidebar selection", () => {
  assert.deepEqual(deriveShellRoute("/action-center?filter=all&item=ask:1"), {
    selectedChannelId: null,
    selectedView: "action-center",
  });
});
