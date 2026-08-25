// desktop/src/features/onboarding/flow/steps.ts
import type { FounderGender } from "../onboardingV2";

/** The ten screens, in the order the spec defines them. */
export const ONBOARDING_STEPS = [
  "account",
  "recovery",
  "company",
  "probing",
  "brain",
  "business",
  "reading",
  "description",
  "credits",
  "invite",
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

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
};

/**
 * Steps that do work the moment they are entered: probing reads the user's
 * computer, install writes to it, and reading spends Colony's own money on a
 * scrape. Back must never land on one of these, and resume must re-run them
 * rather than restore a half-finished result.
 */
const WORKING_STEPS: ReadonlySet<OnboardingStep> = new Set([
  "probing",
  "reading",
]);

export function nextStep(
  current: OnboardingStep,
  answers: OnboardingAnswers,
): OnboardingStep | "done" {
  if (current === "business" && answers.hasWebsite === false) {
    return "description";
  }
  const index = ONBOARDING_STEPS.indexOf(current);
  const next = ONBOARDING_STEPS[index + 1];
  return next ?? "done";
}

/**
 * Null means the screen shows no back control at all. Account and recovery
 * have nothing to go back to once the account exists, and the working steps
 * above must not be re-entered.
 */
const BACK_TARGETS: Partial<Record<OnboardingStep, OnboardingStep>> = {
  company: "account",
  business: "company",
  description: "business",
  credits: "description",
  invite: "credits",
};

export function backStep(current: OnboardingStep): OnboardingStep | null {
  return BACK_TARGETS[current] ?? null;
}

export function resumeStep(answers: OnboardingAnswers): OnboardingStep {
  if (!answers.account) return "account";
  if (!answers.recoveryAcknowledged) return "recovery";
  if (!answers.company) return "company";
  if (!answers.track) return "probing";
  if (!answers.brain) return "brain";
  if (answers.stage === null || answers.hasWebsite === null) return "business";
  if (answers.hasWebsite && !answers.description) return "reading";
  if (!answers.description) return "description";
  if (!answers.paid) return "credits";
  return "invite";
}

export function isWorkingStep(step: OnboardingStep): boolean {
  return WORKING_STEPS.has(step);
}
