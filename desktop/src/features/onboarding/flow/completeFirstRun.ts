// desktop/src/features/onboarding/flow/completeFirstRun.ts
import type { OnboardingV2Draft } from "../onboardingV2";
import {
  buildOnboardingFirstTaskMessage,
  onboardingFirstTaskMarker,
} from "../onboardingV2FirstTask";

/**
 * The one first-run completion, shared by the canvas flow and the legacy
 * community flow so the two paths cannot drift: starter channels + the
 * private Welcome channel ensured, the founder's kind:0 published, Scout's
 * brief delivered exactly once, the router pointed at Welcome, and the
 * app-level gate key written.
 *
 * This module is deliberately free of React and Tauri imports. Everything it
 * touches arrives through {@link CompleteFirstRunIo}; production callers use
 * `DEFAULT_COMPLETE_FIRST_RUN_IO` from `./completeFirstRunIo`, tests pass
 * fakes. The split keeps the node test runner from dragging the whole app
 * module graph into a unit test.
 */

/**
 * `queryClient` is typed loosely on purpose: the pure module must not import
 * TanStack. The io implementation narrows it.
 */
export type CompleteFirstRunDeps = {
  queryClient: unknown;
  relayUrl: string;
  pubkey: string;
  /** Scout's opening brief; null skips delivery entirely. */
  draft: OnboardingV2Draft | null;
  /** kind:0 display name to publish; null/empty skips the profile write. */
  profileDisplayName: string | null;
};

export type CompleteFirstRunResult = {
  focusChannelId: string | null;
  /** Event id of the delivered brief, "already-delivered", or null. */
  firstTaskEventId: string | null;
};

export type CompleteFirstRunIo = {
  initializeStarterChannels: (
    queryClient: unknown,
    args: { focus: boolean; pubkey: string; communityScope: string },
  ) => Promise<{ ok: boolean; reason?: string; focusChannelId?: string }>;
  updateProfile: (input: { displayName: string }) => Promise<unknown>;
  hasMarker: (args: {
    channelId: string;
    marker: string;
    markerScope: "channel";
  }) => Promise<boolean>;
  sendFirstTask: (
    channelId: string,
    content: string,
    marker: string,
  ) => Promise<{ eventId: string }>;
  markComplete: (pubkey: string, relayUrl: string) => void;
  takePendingWelcomeChannelForDirectEntry: () => void;
  navigateToChannel: (channelId: string) => void;
};

/**
 * The profile write is best effort: a founder with no kind:0 still has a
 * working workspace, and settings can publish the name later. The gate key is
 * written last so a thrown step leaves onboarding re-runnable.
 */
export async function completeFirstRun(
  deps: CompleteFirstRunDeps,
  io: CompleteFirstRunIo,
): Promise<CompleteFirstRunResult> {
  const result = await io.initializeStarterChannels(deps.queryClient, {
    focus: true,
    pubkey: deps.pubkey,
    communityScope: deps.relayUrl,
  });
  if (!result.ok && !result.focusChannelId) {
    throw new Error(result.reason ?? "Failed to set up starter channels");
  }
  const focusChannelId = result.focusChannelId ?? null;

  const displayName = deps.profileDisplayName?.trim();
  if (displayName) {
    try {
      await io.updateProfile({ displayName });
    } catch (error) {
      console.warn("First-run profile write failed; continuing.", error);
    }
  }

  let firstTaskEventId: string | null = null;
  const content = deps.draft?.firstTask.content.trim();
  if (deps.draft && content && focusChannelId) {
    const marker = onboardingFirstTaskMarker(deps.draft);
    const exists = await io.hasMarker({
      channelId: focusChannelId,
      marker,
      markerScope: "channel",
    });
    if (exists) {
      firstTaskEventId = "already-delivered";
    } else {
      const sent = await io.sendFirstTask(
        focusChannelId,
        buildOnboardingFirstTaskMessage(deps.draft),
        marker,
      );
      firstTaskEventId = sent.eventId;
    }
  }

  if (focusChannelId) {
    io.takePendingWelcomeChannelForDirectEntry();
    io.navigateToChannel(focusChannelId);
  }
  io.markComplete(deps.pubkey, deps.relayUrl);
  return { focusChannelId, firstTaskEventId };
}
