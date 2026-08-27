// desktop/src/features/onboarding/flow/completeFirstRunIo.ts
import { sendChannelMessage } from "@/shared/api/tauri";
import { hasManagedAgentChannelMessageMarker } from "@/shared/api/tauriManagedAgentMessageMarkers";
import { updateProfile } from "@/shared/api/tauriProfiles";

import { markCommunityOnboardingComplete } from "../communityOnboarding";
import { initializeStarterChannels } from "../hooks";
import { takePendingWelcomeChannelForDirectEntry } from "../welcome";
import type { CompleteFirstRunIo } from "./completeFirstRun";

/**
 * The real wiring for {@link completeFirstRun}. Lives apart from the pure
 * module so unit tests never import React, TanStack, or the Tauri bridge.
 */
export const DEFAULT_COMPLETE_FIRST_RUN_IO: CompleteFirstRunIo = {
  initializeStarterChannels: (queryClient, args) =>
    initializeStarterChannels(
      queryClient as Parameters<typeof initializeStarterChannels>[0],
      args,
    ),
  updateProfile: (input) => updateProfile(input),
  hasMarker: (args) => hasManagedAgentChannelMessageMarker(args),
  sendFirstTask: async (channelId, content, marker) => {
    const sent = await sendChannelMessage(
      channelId,
      content,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [["client", marker]],
    );
    return { eventId: sent.eventId };
  },
  markComplete: markCommunityOnboardingComplete,
  takePendingWelcomeChannelForDirectEntry,
  navigateToChannel: (channelId) => {
    window.location.hash = `/channels/${channelId}`;
  },
};
