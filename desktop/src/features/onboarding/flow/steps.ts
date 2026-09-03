// desktop/src/features/onboarding/flow/steps.ts
import type { FounderGender } from "../onboardingV2";

/**
 * The screens, in the order the spec defines them.
 *
 * `business` used to sit between the brain picker and the reading screen and
 * asked about the same company the company screen had already named, with an
 * unrelated question in between. Its two questions moved onto the company
 * screen, which is where a founder expects to be asked about their company
 * once.
 */
export const ONBOARDING_STEPS = [
  "account",
  "recovery",
  "company",
  "probing",
  "brain",
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
 * Steps that do work the moment they are entered: probing reads the user's
 * computer, and reading spends Colony's own money on a scrape. Back must never
 * land on one of these, and resume must re-run them rather than restore a
 * half-finished result.
 */
const WORKING_STEPS: ReadonlySet<OnboardingStep> = new Set([
  "probing",
  "reading",
]);

export function nextStep(
  current: OnboardingStep,
  answers: OnboardingAnswers,
): OnboardingStep | "done" {
  // The website question is answered on the company screen now, three screens
  // before the reading screen it decides. The skip therefore happens at the
  // brain screen, which is the last one before reading.
  if (current === "brain" && answers.hasWebsite === false) {
    return "description";
  }
  const index = ONBOARDING_STEPS.indexOf(current);
  const next = ONBOARDING_STEPS[index + 1];
  return next ?? "done";
}

/**
 * What decides whether a screen is on this founder's path.
 *
 * `hasWebsite` is the answer as recorded, so `null` (not asked yet) still
 * counts the reading screen in: it is coming unless someone says otherwise.
 * `invitesEnabled` is the build flag, read once per run.
 */
export type StepVisibility = {
  hasWebsite: boolean | null;
  invitesEnabled: boolean;
};

/**
 * The screens this founder will actually see, in order.
 *
 * The counter used to render `index + 1 / ONBOARDING_STEPS.length`, which said
 * "/ 10" on a run that could never reach ten: invites ship dark, so the tenth
 * screen does not exist, and answering "no website" skips the reading screen,
 * which made the counter jump 06 to 08 with nothing in between. A count of
 * screens nobody will see is not a position, it is a guess.
 *
 * The brain screen is always here. It used to be skipped when nothing was
 * installed, on the grounds that a list of one is not a choice; it installs and
 * signs in now, so skipping it is what would remove the choice (see the note in
 * NewOnboardingFlow's probe handler).
 */
export function visibleSteps(state: StepVisibility): OnboardingStep[] {
  return ONBOARDING_STEPS.filter((step) => {
    if (step === "reading") return state.hasWebsite !== false;
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
  description: "company",
  credits: "description",
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
  if (!answers.track) return "probing";
  if (!answers.brain) return "brain";
  if (answers.hasWebsite && !answers.description) return "reading";
  if (!answers.description) return "description";
  if (!answers.paid) return "credits";
  return "invite";
}

export function isWorkingStep(step: OnboardingStep): boolean {
  return WORKING_STEPS.has(step);
}
