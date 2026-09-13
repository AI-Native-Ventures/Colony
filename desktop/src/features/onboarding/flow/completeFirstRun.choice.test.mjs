import assert from "node:assert/strict";
import test from "node:test";

import { completeFirstRun } from "./completeFirstRun.ts";
import { createOnboardingV2Draft } from "../onboardingV2.ts";

test("choice mode uses the channel handoff and never calls the legacy task path", async () => {
  const calls = [];
  const draft = createOnboardingV2Draft();
  draft.firstTask.mode = "choice";
  draft.firstTask.deliveryMarker = "signup-1";
  draft.company.name = "Acme";
  draft.company.summary = "Local service";
  draft.company.hasWebsite = false;
  const result = await completeFirstRun(
    {
      queryClient: {},
      relayUrl: "wss://example.test",
      pubkey: "a".repeat(64),
      draft,
      profileDisplayName: "Ari",
      profileAvatarUrl: null,
    },
    {
      initializeStarterChannels: async () => {
        calls.push("legacy-channels");
        return { ok: true, focusChannelId: "wrong" };
      },
      updateProfile: async () => calls.push("legacy-profile"),
      hasMarker: async () => false,
      sendFirstTask: async () => {
        calls.push("legacy-task");
        return { eventId: "wrong" };
      },
      markComplete: () => calls.push("complete"),
      rememberFounderBrief: () => calls.push("brief"),
      takePendingWelcomeChannelForDirectEntry: () => {},
      navigateToChannel: () => {},
      startChannelOnboarding: async (input) => {
        calls.push(["choice", input.requestId, input.seed.hasWebsite]);
        return { focusChannelId: "welcome", rootEventId: "b".repeat(64) };
      },
    },
  );
  assert.deepEqual(result, {
    focusChannelId: "welcome",
    firstTaskEventId: "b".repeat(64),
  });
  assert.deepEqual(calls, [["choice", "signup-1", false], "complete"]);
});
