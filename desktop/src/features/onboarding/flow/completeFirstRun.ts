import type { FirstJobSuggestion } from "../firstJobSuggestion";
import type { FirstJobSetupScope } from "../firstJobSetup";
import type { FirstJobScope } from "../firstJobStart";
// desktop/src/features/onboarding/flow/completeFirstRun.ts
import type { FounderBriefSummary } from "../founderBriefSummary";
import { founderBriefSummaryFrom } from "../founderBriefSummary";
import type { OnboardingV2Draft } from "../onboardingV2";
import { scoutOnboardingRootSeedFromDraft } from "../channelOnboardingRuntime/protocol";
import type { ScoutInitialHandoffInput } from "../channelOnboardingRuntime/handoff";
import {
  buildOnboardingFirstTaskMessage,
  onboardingFirstTaskMarker,
} from "../onboardingV2FirstTask";

/**
 * The one first-run completion, shared by the canvas flow and the legacy
 * community flow so the two paths cannot drift: starter channels + the
 * private Welcome channel ensured, the founder's kind:0 published, the
 * choice-first root or legacy brief delivered exactly once, the router pointed
 * at Welcome, and the app-level gate key written.
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
  /** Stop subsequent handoff phases after this owner leaves or changes identity. */
  assertCurrent?: () => void;
  relayUrl: string;
  pubkey: string;
  /** The persisted choice-first root or legacy brief; null skips delivery. */
  draft: OnboardingV2Draft | null;
  /** kind:0 display name to publish; null/empty skips the profile write. */
  profileDisplayName: string | null;
  /** Carrying an existing owner's name must not overwrite a newer target name. */
  profileDisplayNameIfMissing?: boolean;
  /** kind:0 avatar to publish; null/empty leaves the profile without one. */
  profileAvatarUrl: string | null;
};

export type CompleteFirstRunResult = {
  focusChannelId: string | null;
  /** Event id of the delivered root/brief, "already-delivered", or null. */
  firstTaskEventId: string | null;
};

export type CompleteFirstRunIo = {
  initializeStarterChannels: (
    queryClient: unknown,
    args: { focus: boolean; pubkey: string; communityScope: string },
  ) => Promise<{ ok: boolean; reason?: string; focusChannelId?: string }>;
  updateProfile: (
    input: { displayName?: string; avatarUrl?: string },
    context: Pick<
      CompleteFirstRunDeps,
      | "queryClient"
      | "relayUrl"
      | "pubkey"
      | "assertCurrent"
      | "profileDisplayNameIfMissing"
    >,
  ) => Promise<unknown>;
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
  /** Required only for the new explicit-Start flow, before Welcome can mount. */
  markExplicitHandoff?: (scope: FirstJobSetupScope) => Promise<void>;
  /** Durable owner-signed setup root. This never dispatches agent work. */
  deliverSuggestion?: (
    payload: FirstJobSuggestion,
    marker: string,
  ) => Promise<{ eventId: string }>;
  /** Retain reviewed context canonically after its signed root is acknowledged. */
  ensureBusinessContext?: (
    scope: FirstJobScope,
    payload: FirstJobSuggestion,
  ) => Promise<void>;
  /** Focus the actual acknowledged setup root in the existing Welcome thread. */
  navigateToThread?: (channelId: string, eventId: string) => void;
  /** Choice-first signup handoff; no company setup or agent work is dispatched. */
  startChannelOnboarding?: (
    input: ScoutInitialHandoffInput,
  ) => Promise<{ focusChannelId: string; rootEventId: string }>;
};

/**
 * A supplied name must be published before completion, so a temporary relay
 * failure cannot discard it and leave the owner named after their key. The
 * gate key is written last so a thrown step leaves onboarding re-runnable.
 */
export async function completeFirstRun(
  deps: CompleteFirstRunDeps,
  io: CompleteFirstRunIo,
): Promise<CompleteFirstRunResult> {
  deps.assertCurrent?.();
  const choiceMode = deps.draft?.firstTask.mode === "choice";
  const suggestionMode = deps.draft?.firstTask.mode === "suggestion";
  if (choiceMode) {
    if (!deps.draft || !io.startChannelOnboarding) {
      throw new Error(
        "The Scout onboarding handoff is unavailable. Update Colony and retry.",
      );
    }
    const handoff = await io.startChannelOnboarding({
      queryClient: deps.queryClient,
      ownerPubkey: deps.pubkey,
      relayUrl: deps.relayUrl,
      requestId: deps.draft.firstTask.deliveryMarker,
      seed: scoutOnboardingRootSeedFromDraft(deps.draft),
      assertCurrent: deps.assertCurrent,
      profile: {
        displayName: deps.profileDisplayName,
        avatarUrl: deps.profileAvatarUrl,
        displayNameIfMissing: deps.profileDisplayNameIfMissing,
      },
    });
    deps.assertCurrent?.();
    io.markComplete(deps.pubkey, deps.relayUrl);
    return {
      focusChannelId: handoff.focusChannelId,
      firstTaskEventId: handoff.rootEventId,
    };
  }
  const ensureBusinessContext = io.ensureBusinessContext;
  if (suggestionMode) {
    if (
      !io.markExplicitHandoff ||
      !io.deliverSuggestion ||
      !io.navigateToThread ||
      !ensureBusinessContext
    ) {
      throw new Error(
        "The explicit first-job handoff is unavailable. Update Colony and retry.",
      );
    }
    await io.markExplicitHandoff({
      ownerPubkey: deps.pubkey,
      relayUrl: deps.relayUrl,
    });
    deps.assertCurrent?.();
  }
  const result = await io.initializeStarterChannels(deps.queryClient, {
    focus: true,
    pubkey: deps.pubkey,
    communityScope: deps.relayUrl,
  });
  deps.assertCurrent?.();
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
      await io.updateProfile(
        {
          ...(displayName ? { displayName } : {}),
          ...(avatarUrl ? { avatarUrl } : {}),
        },
        deps,
      );
    } catch {
      throw new Error(
        "We could not save your profile. Your setup is still here. Try again.",
      );
    }
  }

  deps.assertCurrent?.();

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

  if (
    suggestionMode &&
    deps.draft &&
    io.deliverSuggestion &&
    io.navigateToThread
  ) {
    if (!focusChannelId)
      throw new Error("The Welcome channel is not ready. Retry setup.");
    const payload: FirstJobSuggestion = {
      version: 1,
      ownerPubkey: deps.pubkey,
      relayUrl: deps.relayUrl,
      channelId: focusChannelId,
      requestId: deps.draft.firstTask.deliveryMarker,
      businessName: deps.draft.company.name?.trim() || "Your business",
      business: deps.draft.company.summary.trim(),
      website: deps.draft.company.hasWebsite
        ? deps.draft.company.canonicalUrl
        : "",
      brief: deps.draft.firstTask.content.trim(),
    };
    const sent = await io.deliverSuggestion(
      payload,
      onboardingFirstTaskMarker(deps.draft),
    );
    deps.assertCurrent?.();
    if (!/^[a-f0-9]{64}$/.test(sent.eventId))
      throw new Error(
        "The suggestion's thread could not be verified. Retry setup.",
      );
    io.navigateToThread(focusChannelId, sent.eventId);
    if (!ensureBusinessContext)
      throw new Error(
        "Business setup is unavailable. Update Colony and retry.",
      );
    await ensureBusinessContext(
      {
        ownerPubkey: deps.pubkey,
        relayUrl: deps.relayUrl,
        channelId: focusChannelId,
        threadRootId: sent.eventId,
        requestId: payload.requestId,
      },
      payload,
    );
    deps.assertCurrent?.();
    io.markComplete(deps.pubkey, deps.relayUrl);
    return { focusChannelId, firstTaskEventId: sent.eventId };
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
    deps.assertCurrent?.();
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

  deps.assertCurrent?.();
  io.markComplete(deps.pubkey, deps.relayUrl);
  return { focusChannelId, firstTaskEventId };
}
