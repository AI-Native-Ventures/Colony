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
  "building",
  "brain",
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
};

/**
 * Steps that do work the moment they are entered: building reads the user's
 * computer and spends Colony's own money on a scrape. Back must never land on
 * one of these, and resume must re-run them rather than restore a
 * half-finished result.
 */
const WORKING_STEPS: ReadonlySet<OnboardingStep> = new Set(["building"]);

/**
 * The next screen, in order.
 *
 * `answers` used to decide this: the business screen jumped past reading when
 * there was no website. Reading lives inside `building` now, which asks the
 * question of itself, so the order is the order. The parameter stays because
 * the flow reads it at every call site and the next branch to appear here
 * will need it.
 */
export function nextStep(
  current: OnboardingStep,
  _answers: OnboardingAnswers,
): OnboardingStep | "done" {
  const index = ONBOARDING_STEPS.indexOf(current);
  const next = ONBOARDING_STEPS[index + 1];
  return next ?? "done";
}

/**
 * What decides whether a screen is on this founder's path.
 *
 * `invitesEnabled` is the build flag, read once per run. `hasWebsite` used to
 * be here too, to drop the reading screen from the count when there was no
 * website; reading is a line inside `building` now, so the count no longer
 * moves with the answer.
 */
export type StepVisibility = {
  invitesEnabled: boolean;
};

/**
 * The screens this founder will actually see, in order.
 *
 * The counter used to render `index + 1 / ONBOARDING_STEPS.length`, which said
 * "/ 10" on a run that could never reach ten: invites ship dark, so the tenth
 * screen does not exist. A count of screens nobody will see is not a position,
 * it is a guess.
 *
 * The brain screen is always here. It used to be skipped when nothing was
 * installed, on the grounds that a list of one is not a choice; it installs and
 * signs in now, so skipping it is what would remove the choice (see the note in
 * NewOnboardingFlow's probe handler).
 */
export function visibleSteps(state: StepVisibility): OnboardingStep[] {
  return ONBOARDING_STEPS.filter((step) => {
    if (step === "invite") return state.invitesEnabled;
    return true;
  });
}

/**
 * Where a screen sits on that path, as the counter renders it.
 *
 * A step that is not on the path (a resume that lands mid-change) reports
 * position 0 rather than a negative one, so the marker degrades to the first
 * screen instead of rendering "00".
 */
export function stepPosition(
  step: OnboardingStep,
  state: StepVisibility,
): { index: number; total: number } {
  const steps = visibleSteps(state);
  return { index: Math.max(0, steps.indexOf(step)), total: steps.length };
}

/**
 * Null means the screen shows no back control at all. Account and recovery
 * have nothing to go back to once the account exists, and the working steps
 * above must not be re-entered.
 */
const BACK_TARGETS: Partial<Record<OnboardingStep, OnboardingStep>> = {
  company: "account",
  credits: "brain",
  invite: "credits",
};

export function backStep(current: OnboardingStep): OnboardingStep | null {
  return BACK_TARGETS[current] ?? null;
}

export function resumeStep(answers: OnboardingAnswers): OnboardingStep {
  if (!answers.account) return "account";
  if (!answers.recoveryAcknowledged) return "recovery";
  // Company, stage and website are one screen, so any of the three unanswered
  // resumes onto it.
  if (!answers.company || answers.stage === null || answers.hasWebsite === null)
    return "company";
  // Building produces both, and re-runs rather than restoring half of one.
  if (!answers.track || !answers.description) return "building";
  if (!answers.brain) return "brain";
  if (!answers.paid) return "credits";
  return "invite";
}

export function isWorkingStep(step: OnboardingStep): boolean {
  return WORKING_STEPS.has(step);
}
