// desktop/src/features/onboarding/flow/completeFirstRunIo.ts
import { sendChannelMessage } from "@/shared/api/sendChannelMessage";

import { rememberFounderBrief } from "../founderBriefSummary";
import { hasManagedAgentChannelMessageMarker } from "@/shared/api/tauriManagedAgentMessageMarkers";
import { updateProfile } from "@/shared/api/tauriProfiles";

import { markCommunityOnboardingComplete } from "../communityOnboarding";
import { initializeStarterChannels } from "../hooks";
import { takePendingWelcomeChannelForDirectEntry } from "../welcome";
import { welcomeKickoffContextClientTag } from "../welcomeKickoffContext";
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
  // The marker travels as a client tag, not a Block reference: `welcomeKickoff`
  // and `has_managed_agent_channel_message_marker` both look for
  // `["client", marker]`, and `clientTags` is the validated channel for it.
  //
  // The second tag says what this message *is* rather than which send it was:
  // the founder's own signup context, which the timeline renders as one quiet
  // line so Scout's reply is the first full message they read.
  sendFirstTask: async (channelId, content, marker) => {
    const sent = await sendChannelMessage({
      channelId,
      content,
      parentEventId: null,
      clientTags: [["client", marker], welcomeKickoffContextClientTag()],
    });
    return { eventId: sent.eventId };
  },
  markComplete: markCommunityOnboardingComplete,
  rememberFounderBrief,
  takePendingWelcomeChannelForDirectEntry,
  navigateToChannel: (channelId) => {
    window.location.hash = `/channels/${channelId}`;
  },
};
