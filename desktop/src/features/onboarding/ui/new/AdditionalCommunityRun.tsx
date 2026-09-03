// desktop/src/features/onboarding/ui/new/AdditionalCommunityRun.tsx
import { useCallback, useMemo, useRef } from "react";

import { removeStorageItem } from "@/shared/lib/safeStorage";
import { createFakeServices } from "../../contracts.fake";
import { draftFromAnswers } from "../../flow/founderBrief";
import { ONBOARDING_ANSWERS_KEY } from "../../flow/persistence";
import type { OnboardingAnswers } from "../../flow/steps";
import type { OnboardingV2Draft } from "../../onboardingV2";
import { NewOnboardingFlow } from "./NewOnboardingFlow";

/**
 * Where a second community's answers live.
 *
 * Scoped to the transaction rather than shared with first run: a founder who
 * abandoned first run halfway must not have those answers resumed into a new
 * company, and finishing this walk must not clear theirs.
 */
export function additionalCommunityAnswersKey(transactionId: string): string {
  return `${ONBOARDING_ANSWERS_KEY}.community:${transactionId}`;
}

/**
 * The way out, pinned to the canvas rather than to a screen.
 *
 * This walk is the one a founder did not have to start: they already have a
 * workspace to go back to, and the community itself is already created by the
 * time the first screen renders. So every screen carries this, and pressing it
 * finishes the community's onboarding rather than abandoning it half-made.
 */
export function CommunityOnboardingExit({ onExit }: { onExit: () => void }) {
  return (
    <button
      className="onb-exit onb-quiet-action"
      data-testid="community-onboarding-exit"
      onClick={onExit}
      type="button"
    >
      Back to Colony
    </button>
  );
}

type Props = {
  /** The community-onboarding transaction this walk belongs to. */
  transactionId: string;
  /**
   * The draft already on the transaction, if any. Only its delivery marker is
   * used: reusing it is what stops a relaunch, or a retried handoff, sending
   * Scout's brief a second time.
   */
  initialDraft: OnboardingV2Draft | null;
  /** Runs the shared completion against the community just created. */
  onComplete: (draft: OnboardingV2Draft) => Promise<void>;
  /** Leaves the walk for the workspace, from any screen. */
  onExit: () => void;
};

/**
 * The founder walk for a community created by someone who is already signed
 * in: the same canvas screens as first run, minus the two that make an
 * account.
 *
 * This journey used to be its own flow (`OnboardingV2Flow`), which is how a
 * founder on canary reached three pastel screens that looked nothing like the
 * ones every other founder sees, with no way out and a transaction in local
 * storage that put them back there on relaunch. The screens are the same
 * screens now, and the way out is on all of them.
 */
export function AdditionalCommunityRun({
  transactionId,
  initialDraft,
  onComplete,
  onExit,
}: Props) {
  // Payments, scrape and invites stay fakes here exactly as in first run;
  // NewOnboardingFlow swaps in the wired services outside the e2e build.
  const services = useMemo(() => createFakeServices(), []);
  const answersKey = additionalCommunityAnswersKey(transactionId);

  const leave = useCallback(() => {
    // The walk is over either way, so its answers go with it: nothing offers
    // this transaction again once onboarding is marked complete.
    removeStorageItem(answersKey);
    onExit();
  }, [answersKey, onExit]);

  const draftRef = useRef<OnboardingV2Draft | null>(initialDraft);
  const handleComplete = useCallback(
    (answers: OnboardingAnswers) => {
      const built = draftFromAnswers(answers);
      const previous = draftRef.current;
      const draft: OnboardingV2Draft = previous
        ? {
            ...built,
            firstTask: {
              ...built.firstTask,
              deliveryMarker: previous.firstTask.deliveryMarker,
              deliveredEventId: previous.firstTask.deliveredEventId,
            },
          }
        : built;
      draftRef.current = draft;
      return onComplete(draft);
    },
    [onComplete],
  );

  return (
    <NewOnboardingFlow
      answersKey={answersKey}
      canvasOverlay={<CommunityOnboardingExit onExit={leave} />}
      existingIdentity
      onComplete={handleComplete}
      onLeaveRun={leave}
      provisioning={null}
      services={services}
    />
  );
}
