// desktop/src/features/onboarding/flow/completeFirstRun.ts
import type { FounderBriefSummary } from "../founderBriefSummary";
import { founderBriefSummaryFrom } from "../founderBriefSummary";
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
  /** kind:0 avatar to publish; null/empty leaves the profile without one. */
  profileAvatarUrl: string | null;
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
  updateProfile: (input: {
    displayName?: string;
    avatarUrl?: string;
  }) => Promise<unknown>;
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
  /**
   * Hand the founder's own answers to whatever greets them next. Without this
   * the Chief of Staff opens by asking for a website they already supplied.
   */
  rememberFounderBrief: (summary: FounderBriefSummary) => void;
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

  // Name and picture go up together: they are one kind:0, and writing them
  // separately would publish two replaceable events where one will do. Each is
  // omitted when empty rather than sent blank, so skipping the photo leaves an
  // existing avatar alone instead of clearing it.
  const displayName = deps.profileDisplayName?.trim();
  const avatarUrl = deps.profileAvatarUrl?.trim();
  if (displayName || avatarUrl) {
    try {
      await io.updateProfile({
        ...(displayName ? { displayName } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
      });
    } catch (error) {
      console.warn("First-run profile write failed; continuing.", error);
    }
  }

  // Land the founder in Welcome BEFORE the brief is delivered. Delivery is a
  // network write that can fail; landing is not. On 2026-08-27 a first run hit
  // a send error here and the founder was left on whatever route the app
  // happened to boot into, with a working workspace they had to go and find by
  // hand. A brief that fails to send costs one message and a retry; a founder
  // who never reaches their own workspace has nowhere to retry from.
  if (focusChannelId) {
    io.takePendingWelcomeChannelForDirectEntry();
    io.navigateToChannel(focusChannelId);
  }

  if (deps.draft) {
    io.rememberFounderBrief(founderBriefSummaryFrom(deps.draft));
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

  io.markComplete(deps.pubkey, deps.relayUrl);
  return { focusChannelId, firstTaskEventId };
}
