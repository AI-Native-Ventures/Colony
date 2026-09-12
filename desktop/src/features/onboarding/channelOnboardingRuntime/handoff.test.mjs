import assert from "node:assert/strict";
import test from "node:test";

import { startScoutOnboardingHandoff } from "./handoff.ts";

test("initial handoff suppresses Welcome seeding and delivers the signup root", async () => {
  const calls = [];
  const input = {
    queryClient: {},
    ownerPubkey: "a".repeat(64),
    relayUrl: "wss://example.test",
    requestId: "signup-1",
    seed: {
      ownerName: "Ari",
      businessName: "Acme",
      businessDescription: "Local service",
      hasWebsite: false,
    },
    profile: { displayName: "Ari" },
  };
  const result = await startScoutOnboardingHandoff(input, {
    markExplicitHandoff: async (scope) => calls.push(["mark", scope]),
    initializeStarterChannels: async (_queryClient, args) => {
      calls.push(["channels", args]);
      return { ok: true, focusChannelId: "welcome" };
    },
    updateProfile: async (profile) => calls.push(["profile", profile]),
    deliverRoot: async (payload) => {
      calls.push(["root", payload]);
      return { eventId: "b".repeat(64) };
    },
    takePendingWelcomeChannelForDirectEntry: () => calls.push(["pending"]),
    navigateToChannel: (channelId) => calls.push(["channel", channelId]),
    navigateToThread: (channelId, eventId) =>
      calls.push(["thread", channelId, eventId]),
  });

  assert.deepEqual(result, {
    focusChannelId: "welcome",
    rootEventId: "b".repeat(64),
  });
  assert.equal(calls[1][1].seedWelcomeExperience, false);
  assert.equal(calls[5][1].seed.websiteState, "none");
  assert.deepEqual(
    calls.map((call) => call[0]),
    ["mark", "channels", "profile", "pending", "channel", "root", "thread"],
  );
});

test("a missing focus channel fails before profile or root delivery", async () => {
  const calls = [];
  await assert.rejects(
    startScoutOnboardingHandoff(
      {
        queryClient: {},
        ownerPubkey: "a".repeat(64),
        relayUrl: "wss://example.test",
        requestId: "signup-1",
        seed: {},
      },
      {
        markExplicitHandoff: async () => calls.push("mark"),
        initializeStarterChannels: async () => ({
          ok: false,
          reason: "offline",
        }),
        deliverRoot: async () => {
          calls.push("root");
          return { eventId: "b".repeat(64) };
        },
        takePendingWelcomeChannelForDirectEntry: () => calls.push("pending"),
        navigateToChannel: () => calls.push("channel"),
      },
    ),
    /offline/,
  );
  assert.deepEqual(calls, ["mark"]);
});
