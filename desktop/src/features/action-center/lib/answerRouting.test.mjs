import assert from "node:assert/strict";
import test from "node:test";

import { resolveAskAnswerRoute } from "./answerRouting.ts";

test("routes to a thread reply when the ask carries both a channel and a thread", () => {
  const route = resolveAskAnswerRoute({
    channelId: "channel-1",
    threadId: "thread-1",
  });
  assert.deepEqual(route, {
    kind: "thread-reply",
    channelId: "channel-1",
    threadId: "thread-1",
  });
});

test("routes to a resolution card when the ask has no origin thread", () => {
  const route = resolveAskAnswerRoute({ channelId: null, threadId: null });
  assert.deepEqual(route, { kind: "resolution-card" });
});

test("routes to a resolution card when only one of channelId/threadId is present", () => {
  assert.deepEqual(
    resolveAskAnswerRoute({ channelId: "channel-1", threadId: null }),
    { kind: "resolution-card" },
  );
  assert.deepEqual(
    resolveAskAnswerRoute({ channelId: null, threadId: "thread-1" }),
    { kind: "resolution-card" },
  );
});
