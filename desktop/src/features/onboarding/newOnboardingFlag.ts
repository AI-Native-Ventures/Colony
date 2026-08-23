// desktop/src/features/onboarding/newOnboardingFlag.ts

type Env = Record<string, string | undefined>;

type StorageLike = Pick<Storage, "getItem"> | null;

/**
 * The redesigned flow is the flow. It ships on by default, and the switch
 * survives only as a kill switch: a release can set VITE_NEW_ONBOARDING=0 to
 * fall back to the previous flow without a code change.
 */
/**
 * The e2e override, read once per session.
 *
 * Onboarding is exactly where storage gets wiped mid-run: an identity reset
 * and a sign-out both clear it. Re-reading on every render meant the flow
 * could change identity underneath someone halfway through, swapping the
 * screens they were filling in. Freezing the lookup is what makes the flow
 * stable, not an optimisation. The env checks stay live because they cannot
 * change while the app is running.
 */
let cachedOverride: string | null | undefined;

function readOverride(): string | null {
  if (cachedOverride === undefined) {
    cachedOverride =
      typeof localStorage === "undefined"
        ? null
        : localStorage.getItem("colony.e2e.newOnboarding");
  }
  return cachedOverride;
}

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
  // An explicit storage argument is a caller asking about a specific state,
  // which is what the tests do; only the ambient lookup is frozen.
  const override =
    storage !== undefined
      ? (storage?.getItem("colony.e2e.newOnboarding") ?? null)
      : readOverride();
  return override !== "0";
}

/** Test seam: drops the frozen override so a case can set up a new one. */
export function resetNewOnboardingFlagCache(): void {
  cachedOverride = undefined;
}

export function invitesEnabled(env: Env, storage?: StorageLike): boolean {
  return (
    isNewOnboardingEnabled(env, storage) && env.VITE_ONBOARDING_INVITES === "1"
  );
}
