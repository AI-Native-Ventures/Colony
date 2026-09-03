import type { OnboardingAnswers } from "./steps";

export const ONBOARDING_ANSWERS_KEY = "colony.onboarding.answers";

export type AnswerStorage = {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
};

export const EMPTY_ANSWERS: OnboardingAnswers = {
  account: null,
  founder: null,
  recoveryAcknowledged: false,
  company: null,
  track: null,
  brain: null,
  stage: null,
  hasWebsite: null,
  website: null,
  description: null,
  paid: false,
  communitySlug: null,
};

/**
 * Rebuilds a known-shaped object rather than trusting whatever is on disk.
 * A stored blob from an older build can carry keys this version has never
 * heard of, and passing those through would leak into the flow's branching.
 */
function coerce(raw: unknown): OnboardingAnswers {
  if (!raw || typeof raw !== "object") return { ...EMPTY_ANSWERS };
  const value = raw as Partial<OnboardingAnswers>;
  return {
    account: value.account ?? null,
    // Rebuilt field by field for the same reason as the rest: a resumed draft
    // from an older build has no founder at all.
    founder: value.founder
      ? {
          fullName: value.founder.fullName ?? "",
          city: value.founder.city ?? "",
          country: value.founder.country ?? "",
          gender: value.founder.gender ?? null,
          selfDescribedGender: value.founder.selfDescribedGender ?? "",
          // Absent in every draft written before the photo was collected, so
          // a run resumed across that upgrade keeps its answers instead of
          // being thrown away for a missing key.
          avatarUrl: value.founder.avatarUrl ?? "",
        }
      : null,
    recoveryAcknowledged: value.recoveryAcknowledged === true,
    company: value.company ?? null,
    track: value.track ?? null,
    brain: value.brain ?? null,
    stage: value.stage ?? null,
    hasWebsite: value.hasWebsite ?? null,
    website: value.website ?? null,
    description: value.description ?? null,
    paid: value.paid === true,
    communitySlug: value.communitySlug ?? null,
  };
}

/**
 * Which run these answers belong to.
 *
 * First run owns {@link ONBOARDING_ANSWERS_KEY} and is the only caller that
 * leaves this alone. A founder creating a second community walks the same
 * screens, so its answers need a key of their own: sharing one would resume
 * the second walk onto the first company's answers, or wipe them.
 */
export function loadAnswers(
  storage: AnswerStorage,
  key: string = ONBOARDING_ANSWERS_KEY,
): OnboardingAnswers {
  const stored = storage.get(key);
  if (!stored) return { ...EMPTY_ANSWERS };
  try {
    return coerce(JSON.parse(stored));
  } catch {
    return { ...EMPTY_ANSWERS };
  }
}

export function saveAnswers(
  storage: AnswerStorage,
  answers: OnboardingAnswers,
  key: string = ONBOARDING_ANSWERS_KEY,
): void {
  storage.set(key, JSON.stringify(answers));
}

export function clearAnswers(
  storage: AnswerStorage,
  key: string = ONBOARDING_ANSWERS_KEY,
): void {
  storage.remove(key);
}
