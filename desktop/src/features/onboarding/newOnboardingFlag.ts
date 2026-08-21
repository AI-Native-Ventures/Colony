// desktop/src/features/onboarding/newOnboardingFlag.ts

type Env = Record<string, string | undefined>;

/**
 * The redesigned flow ships dark until it is signed off. Both switches are
 * read from the build environment so a release can enable them without a code
 * change.
 */
export function isNewOnboardingEnabled(env: Env): boolean {
  return env.VITE_NEW_ONBOARDING === "1";
}

export function invitesEnabled(env: Env): boolean {
  return isNewOnboardingEnabled(env) && env.VITE_ONBOARDING_INVITES === "1";
}
