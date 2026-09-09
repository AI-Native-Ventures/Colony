// desktop/src/features/onboarding/flow/steps.ts
import type { FounderGender } from "../onboardingV2";

/**
 * The screens, in the order the spec defines them.
 *
 * This was ten. Three of them asked about the same company (`company`,
 * `business`) and three showed one stretch of work split across screens
 * (`probing`, `reading`, `description`), which is how a founder ended up
 * describing their business twice and watching two progress screens that
 * never showed what came of them.
 *
 * `business` folded into `company`; `probing`, `reading` and `description`
 * folded into `building`, which does both jobs and ends on the draft they
 * produced. `invite` still ships dark, so six is what anyone sees.
 */
export const ONBOARDING_STEPS = [
  "account",
  "recovery",
  "company",
  "brain",
  "invite",
] as const;

// Legacy names remain readable while older saved answers migrate. They are
// never rendered by the default journey.
export type OnboardingStep =
  | (typeof ONBOARDING_STEPS)[number]
  | "building"
  | "credits";

export type OnboardingTrack = "byo" | "colony";

/**
 * Who the founder is.
 *
 * Carried over from the flow this one replaces: none of it is stored as a
 * record, it is what Scout's opening brief is built from, so dropping any of
 * it silently degrades the first thing an agent knows about the company.
 */
export type OnboardingFounder = {
  fullName: string;
  city: string;
  country: string;
  gender: FounderGender | null;
  selfDescribedGender: string;
  /**
   * Profile picture, as a URL or an emoji data URL, empty when skipped.
   *
   * Unlike every other field here this one IS a record: it is written to the
   * founder's profile at the end of the run. It rides along with the rest of
   * the founder answers so a resumed run keeps a picture someone already
   * chose, rather than making them pick again.
   */
  avatarUrl: string;
};

export type OnboardingAnswers = {
  account: { email: string } | null;
  founder: OnboardingFounder | null;
  recoveryAcknowledged: boolean;
  company: string | null;
  track: OnboardingTrack | null;
  brain: string | null;
  stage: "live" | "building" | null;
  hasWebsite: boolean | null;
  website: string | null;
  description: string | null;
  paid: boolean;
  /** Hosted address claimed for this run, for idempotent resume. */
  communitySlug: string | null;
  /** Chosen before a create request, retained across uncertain responses. */
  provisioningCandidate?: string | null;
  /** Public markers only. Recovery material lives in the native SecretStore. */
  signupAttemptId?: string | null;
  identityPubkey?: string | null;
  firstTaskMarker?: string | null;
  /** Public resume marker; provider credentials never enter this record. */
  businessConfirmed?: boolean;
};

/** Funding is handled by the existing workspace, never by account setup. */
export function creditsNeeded(_answers: OnboardingAnswers): boolean {
  return false;
}

export function nextStep(
  current: OnboardingStep,
  _answers: OnboardingAnswers,
): OnboardingStep | "done" {
  if (current === "account") return "recovery";
  if (current === "recovery") return "company";
  if (current === "company") return "brain";
  return "done";
}

export type StepVisibility = {
  invitesEnabled: boolean;
  creditsNeeded: boolean;
};
export function visibleSteps(_state: StepVisibility): OnboardingStep[] {
  return ["account", "company", "brain"];
}
export function stepPosition(
  step: OnboardingStep,
  _state: StepVisibility,
): { index: number; total: number } {
  return {
    index:
      step === "account" || step === "recovery" ? 0 : step === "brain" ? 2 : 1,
    total: 3,
  };
}
export function backStep(
  _current: OnboardingStep,
  _state: StepVisibility,
): OnboardingStep | null {
  return null;
}
export function resumeStep(answers: OnboardingAnswers): OnboardingStep {
  if (!answers.account) return "account";
  if (!answers.recoveryAcknowledged) return "recovery";
  // Only an explicit confirmation in this flow advances to power selection.
  // Older drafts stay editable and never infer consent from a stored runtime.
  return answers.businessConfirmed ? "brain" : "company";
}
export function isWorkingStep(_step: OnboardingStep): boolean {
  return false;
}
