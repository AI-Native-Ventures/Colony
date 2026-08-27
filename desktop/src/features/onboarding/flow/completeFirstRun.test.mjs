import assert from "node:assert/strict";
import { test } from "node:test";

import { createOnboardingV2Draft } from "../onboardingV2.ts";
import { completeFirstRun } from "./completeFirstRun.ts";

function makeIo(overrides = {}) {
  const calls = [];
  return {
    calls,
    io: {
      initializeStarterChannels: async () => {
        calls.push("channels");
        return { ok: true, focusChannelId: "chan-1" };
      },
      updateProfile: async (input) => {
        calls.push(`profile:${input.displayName}`);
        return {};
      },
      hasMarker: async () => false,
      sendFirstTask: async () => {
        calls.push("task");
        return { eventId: "evt-9" };
      },
      markComplete: (pubkey, relayUrl) => {
        calls.push(`complete:${pubkey}:${relayUrl}`);
      },
      takePendingWelcomeChannelForDirectEntry: () => {},
      navigateToChannel: (id) => calls.push(`nav:${id}`),
      ...overrides,
    },
  };
}

const base = createOnboardingV2Draft();
const draft = {
  ...base,
  firstTask: { ...base.firstTask, content: "Get to know Acme." },
};

test("happy path: channels, profile, task, gate key, navigation", async () => {
  const { io, calls } = makeIo();
  const result = await completeFirstRun(
    {
      queryClient: {},
      relayUrl: "wss://acme.test",
      pubkey: "pk1",
      draft,
      profileDisplayName: "Aisha Bello",
    },
    io,
  );
  assert.equal(result.focusChannelId, "chan-1");
  assert.equal(result.firstTaskEventId, "evt-9");
  assert.deepEqual(calls, [
    "channels",
    "profile:Aisha Bello",
    "task",
    "nav:chan-1",
    "complete:pk1:wss://acme.test",
  ]);
});

test("skips delivery when the marker already exists", async () => {
  const { io, calls } = makeIo({ hasMarker: async () => true });
  const result = await completeFirstRun(
    {
      queryClient: {},
      relayUrl: "wss://r",
      pubkey: "pk",
      draft,
      profileDisplayName: null,
    },
    io,
  );
  assert.equal(result.firstTaskEventId, "already-delivered");
  assert.ok(!calls.includes("task"));
  assert.ok(!calls.some((c) => c.startsWith("profile:")));
});

test("skips delivery when draft is null or content empty", async () => {
  const { io, calls } = makeIo();
  await completeFirstRun(
    {
      queryClient: {},
      relayUrl: "wss://r",
      pubkey: "pk",
      draft: null,
      profileDisplayName: null,
    },
    io,
  );
  assert.ok(!calls.includes("task"));
});

test("throws when starter channels fail without a focus channel", async () => {
  const { io } = makeIo({
    initializeStarterChannels: async () => ({ ok: false, reason: "boom" }),
  });
  await assert.rejects(
    completeFirstRun(
      {
        queryClient: {},
        relayUrl: "wss://r",
        pubkey: "pk",
        draft: null,
        profileDisplayName: null,
      },
      io,
    ),
    /boom/,
  );
});

test("profile write failure does not block completion", async () => {
  const { io, calls } = makeIo({
    updateProfile: async () => {
      throw new Error("profile down");
    },
  });
  const result = await completeFirstRun(
    {
      queryClient: {},
      relayUrl: "wss://r",
      pubkey: "pk",
      draft: null,
      profileDisplayName: "Aisha",
    },
    io,
  );
  assert.equal(result.focusChannelId, "chan-1");
  assert.ok(calls.includes("complete:pk:wss://r"));
});
