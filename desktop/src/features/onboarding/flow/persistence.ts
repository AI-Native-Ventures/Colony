import type { OnboardingAnswers } from "./steps";

export const ONBOARDING_ANSWERS_KEY = "colony.onboarding.answers";

export type AnswerStorage = {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  remove: (key: string) => void;
};

export const EMPTY_ANSWERS: OnboardingAnswers = {
  account: null,
  recoveryAcknowledged: false,
  company: null,
  track: null,
  brain: null,
  stage: null,
  hasWebsite: null,
  website: null,
  description: null,
  paid: false,
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
    recoveryAcknowledged: value.recoveryAcknowledged === true,
    company: value.company ?? null,
    track: value.track ?? null,
    brain: value.brain ?? null,
    stage: value.stage ?? null,
    hasWebsite: value.hasWebsite ?? null,
    website: value.website ?? null,
    description: value.description ?? null,
    paid: value.paid === true,
  };
}

export function loadAnswers(storage: AnswerStorage): OnboardingAnswers {
  const stored = storage.get(ONBOARDING_ANSWERS_KEY);
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
): void {
  storage.set(ONBOARDING_ANSWERS_KEY, JSON.stringify(answers));
}

export function clearAnswers(storage: AnswerStorage): void {
  storage.remove(ONBOARDING_ANSWERS_KEY);
}
