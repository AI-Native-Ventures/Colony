import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import { assertFirstJobScope } from "../firstJobScope";
import { markExplicitFirstJobSetup } from "../firstJobSetup";
import { withFirstJobBrowserLock } from "../firstJobStorage";
import { createFirstJobSuggestionDelivery } from "../firstJobSuggestionDelivery";
// desktop/src/features/onboarding/flow/completeFirstRunIo.ts
import { sendChannelMessage } from "@/shared/api/sendChannelMessage";

import { rememberFounderBrief } from "../founderBriefSummary";
import { hasManagedAgentChannelMessageMarker } from "@/shared/api/tauriManagedAgentMessageMarkers";
import { updateProfile } from "@/shared/api/tauriProfiles";
import { refreshProfileCaches } from "@/features/profile/profileCacheSync";
import type { QueryClient } from "@tanstack/react-query";

import { markCommunityOnboardingComplete } from "../communityOnboarding";
import { initializeStarterChannels } from "../hooks";
import { takePendingWelcomeChannelForDirectEntry } from "../welcome";
import { welcomeKickoffContextClientTag } from "../welcomeKickoffContext";
import type { CompleteFirstRunIo } from "./completeFirstRun";

// Access storage lazily: its getter can throw, and importing the app must still work.
const suggestionDelivery = createFirstJobSuggestionDelivery({
  storage: {
    getItem: (key) => globalThis.localStorage.getItem(key),
    setItem: (key, value) => globalThis.localStorage.setItem(key, value),
  },
  assertCurrent: assertFirstJobScope,
  withLock: withFirstJobBrowserLock,
  sign: signRelayEvent,
  publish: (event, scope) =>
    relayClient.publishEvent(
      event,
      "Colony could not confirm this suggestion was saved. Retry to check the same request.",
      "Colony could not save this suggestion. Retry to check the same request.",
      scope.relayUrl,
    ),
  now: Date.now,
});

/**
 * The real wiring for {@link completeFirstRun}. Lives apart from the pure
 * module so unit tests never import React, TanStack, or the Tauri bridge.
 */
export const DEFAULT_COMPLETE_FIRST_RUN_IO: CompleteFirstRunIo = {
  markExplicitHandoff: async (scope) => {
    await assertFirstJobScope(scope);
    markExplicitFirstJobSetup(scope);
  },
  deliverSuggestion: suggestionDelivery.deliver,
  navigateToThread: (channelId, eventId) => {
    const params = new URLSearchParams({
      thread: eventId,
      threadRootId: eventId,
      messageId: eventId,
    });
    window.location.hash = `/channels/${encodeURIComponent(channelId)}?${params}`;
  },
  initializeStarterChannels: (queryClient, args) =>
    initializeStarterChannels(
      queryClient as Parameters<typeof initializeStarterChannels>[0],
      args,
    ),
  updateProfile: async (input, context) => {
    context.assertCurrent?.();
    await assertFirstJobScope({
      ownerPubkey: context.pubkey,
      relayUrl: context.relayUrl,
    });
    const profile = await updateProfile(input, {
      pubkey: context.pubkey,
      relayUrl: context.relayUrl,
    });
    context.assertCurrent?.();
    if (profile.pubkey.toLowerCase() !== context.pubkey.toLowerCase()) {
      throw new Error("The active account changed. Retry setup.");
    }
    await refreshProfileCaches(
      context.queryClient as QueryClient,
      profile,
      context.relayUrl,
    );
    return profile;
  },
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
