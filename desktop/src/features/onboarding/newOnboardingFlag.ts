// desktop/src/features/onboarding/newOnboardingFlag.ts

type Env = Record<string, string | undefined>;

type StorageLike = Pick<Storage, "getItem"> | null;

/**
 * The redesigned flow is the flow. It ships on by default, and the switch
 * survives only as a kill switch: a release can set VITE_NEW_ONBOARDING=0 to
 * fall back to the previous flow without a code change.
 */
export function isNewOnboardingEnabled(
  env: Env,
  storage?: StorageLike,
): boolean {
  if (env.VITE_NEW_ONBOARDING === "0") return false;
  if (env.VITE_NEW_ONBOARDING === "1") return true;
  // E2E only: lets the first-run specs that still assert the previous flow
  // opt out of the redesign, without flipping it off for everything else.
  // The mode check keeps the override unreachable in a production build.
  if (env.MODE !== "e2e") return true;
  const source =
    storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  return source?.getItem("colony.e2e.newOnboarding") !== "0";
}

export function invitesEnabled(env: Env, storage?: StorageLike): boolean {
  return (
    isNewOnboardingEnabled(env, storage) && env.VITE_ONBOARDING_INVITES === "1"
  );
}
