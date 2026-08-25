// desktop/src/features/onboarding/flow/stashFounderBrief.ts
import {
  loadCommunityOnboardingTransaction,
  updateCommunityOnboardingTransaction,
} from "../communityOnboarding";
import { draftFromAnswers } from "./founderBrief";
import type { OnboardingAnswers } from "./steps";

/**
 * Leave the founder and company answers where the brief is sent from.
 *
 * Delivery is unchanged and still lives in CommunityOnboardingFlow: after the
 * community exists it reads `transaction.onboardingV2` and posts the brief as
 * the first message. This only fills that field, so the two halves stay
 * decoupled and nothing here needs to know about channels or markers.
 *
 * Best-effort by design. A missing transaction means the community was made
 * before this flow ran, and a storage failure is already survivable
 * everywhere else in onboarding; neither is worth blocking someone's first
 * run over.
 */
export function stashFounderBrief(
  answers: OnboardingAnswers,
  storage: Storage | undefined = typeof localStorage === "undefined"
    ? undefined
    : localStorage,
): void {
  if (!storage) return;
  try {
    const transaction = loadCommunityOnboardingTransaction(storage);
    if (!transaction) return;
    updateCommunityOnboardingTransaction(
      transaction,
      { onboardingV2: draftFromAnswers(answers) },
      storage,
    );
  } catch {
    // Onboarding completes either way: the brief is context, not a gate.
  }
}
