// desktop/src/features/onboarding/newOnboardingFlag.ts

type Env = Record<string, string | undefined>;

type StorageLike = Pick<Storage, "getItem"> | null;

/**
 * The redesigned flow ships dark until it is signed off. The primary switch
 * is read from the build environment so a release can enable it without a
 * code change.
 */
export function isNewOnboardingEnabled(
  env: Env,
  storage?: StorageLike,
): boolean {
  if (env.VITE_NEW_ONBOARDING === "1") return true;
  // E2E only: lets one spec opt into the redesigned flow without flipping it
  // on for every other first-run spec, which still assert the old one. The
  // mode check keeps this unreachable in a production build.
  if (env.MODE !== "e2e") return false;
  const source =
    storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  return source?.getItem("colony.e2e.newOnboarding") === "1";
}

export function invitesEnabled(env: Env, storage?: StorageLike): boolean {
  return (
    isNewOnboardingEnabled(env, storage) && env.VITE_ONBOARDING_INVITES === "1"
  );
}
