import assert from "node:assert/strict";
import test from "node:test";

import {
  findTopVisibleThreadMessageId,
  getLayoutScrollTarget,
  getLayoutScrollOffsetDelta,
  getResolvedThreadTargets,
  getScopedLayoutScrollTargetId,
  restoreLayoutScrollTargetOffset,
} from "./useThreadViewModeSwitch.ts";

function row(id, top, bottom) {
  return {
    dataset: { messageId: id },
    getBoundingClientRect: () => ({ bottom, top }),
  };
}

test("finds the first thread message crossing the viewport top", () => {
  const rows = [
    row("above", -80, -5),
    row("crossing", -20, 30),
    row("below", 40, 90),
  ];
  const body = {
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => rows,
  };

  assert.equal(findTopVisibleThreadMessageId(body), "crossing");
});

test("captures the visible message in the active thread before layout changes", () => {
  const body = {
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => [row("above", -80, -5), row("anchor", -20, 30)],
  };

  assert.deepEqual(getLayoutScrollTarget(body, "thread-a", "channel-a"), {
    channelId: "channel-a",
    messageId: "anchor",
    topOffsetPx: -20,
    threadHeadId: "thread-a",
  });
  assert.equal(getLayoutScrollTarget(body, null, "channel-a"), null);
  assert.equal(getLayoutScrollTarget(body, "thread-a", null), null);
});

test("restores a captured message to its pre-layout viewport offset", () => {
  let scrollTop = 400;
  const body = {
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value) {
      scrollTop = value;
    },
    getBoundingClientRect: () => ({ top: 100 }),
    querySelectorAll: () => [row("anchor", 140, 190)],
  };

  assert.equal(
    restoreLayoutScrollTargetOffset(body, {
      channelId: "channel-a",
      messageId: "anchor",
      threadHeadId: "thread-a",
      topOffsetPx: -10,
    }),
    true,
  );
  assert.equal(scrollTop, 450);
});

test("calculates the signed offset correction after layout reflow", () => {
  const body = { getBoundingClientRect: () => ({ top: 100 }) };

  assert.equal(
    getLayoutScrollOffsetDelta(
      body,
      { getBoundingClientRect: () => ({ top: 155 }) },
      -10,
    ),
    65,
  );
  assert.equal(
    getLayoutScrollOffsetDelta(
      body,
      { getBoundingClientRect: () => ({ top: 70 }) },
      -10,
    ),
    -20,
  );
});

test("resolves both sources when a layout anchor matches the external target", () => {
  assert.deepEqual(
    getResolvedThreadTargets({
      externalTargetId: "reply-b",
      layoutTargetId: "reply-b",
    }),
    { resolveExternal: true, resolveLayout: true },
  );
  assert.deepEqual(
    getResolvedThreadTargets({
      externalTargetId: "reply-b",
      layoutTargetId: "reply-c",
    }),
    { resolveExternal: false, resolveLayout: true },
  );
});

test("does not resolve a layout target that was never captured", () => {
  assert.deepEqual(
    getResolvedThreadTargets({
      externalTargetId: "reply-b",
      layoutTargetId: null,
    }),
    { resolveExternal: true, resolveLayout: false },
  );
  assert.deepEqual(
    getResolvedThreadTargets({
      externalTargetId: null,
      layoutTargetId: null,
    }),
    { resolveExternal: true, resolveLayout: false },
  );
});

test("drops a captured layout target when the active scope changes", () => {
  const captured = {
    channelId: "channel-a",
    messageId: "reply-a",
    threadHeadId: "thread-a",
  };

  assert.equal(
    getScopedLayoutScrollTargetId({
      activeThreadHeadId: "thread-a",
      channelId: "channel-a",
      layoutTarget: captured,
    }),
    "reply-a",
  );
  assert.equal(
    getScopedLayoutScrollTargetId({
      activeThreadHeadId: null,
      channelId: "channel-a",
      layoutTarget: captured,
    }),
    null,
  );
  const replacementLayoutTargetId = getScopedLayoutScrollTargetId({
    activeThreadHeadId: "thread-b",
    channelId: "channel-a",
    layoutTarget: captured,
  });
  assert.equal(replacementLayoutTargetId, null);
  assert.equal(
    getScopedLayoutScrollTargetId({
      activeThreadHeadId: "thread-a",
      channelId: "channel-b",
      layoutTarget: captured,
    }),
    null,
  );
  assert.deepEqual(
    getResolvedThreadTargets({
      externalTargetId: "reply-b",
      layoutTargetId: replacementLayoutTargetId,
    }),
    { resolveExternal: true, resolveLayout: false },
    "the stale anchor does not mask the replacement thread target",
  );
});

test("returns null without a mounted thread body or visible message", () => {
  assert.equal(findTopVisibleThreadMessageId(null), null);
  assert.equal(
    findTopVisibleThreadMessageId({
      getBoundingClientRect: () => ({ top: 0 }),
      querySelectorAll: () => [row("above", -80, -1)],
    }),
    null,
  );
});
