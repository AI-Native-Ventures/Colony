// desktop/src/features/onboarding/freshFounder.ts
import { onboardingCompletionStorageKey } from "./completionKey";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const FRESH_IDENTITY_KEY_PREFIX = "colony.identity.fresh";

function freshIdentityKey(pubkey: string): string {
  return `${FRESH_IDENTITY_KEY_PREFIX}:${pubkey}`;
}

function ambientStorage(): StorageLike | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

/**
 * Written only by machine onboarding's fresh-identity path ("Start with
 * Colony" on a computer with no prior identity). An imported identity never
 * gets it, which is what keeps returning users out of the founder flow: with
 * no relay applied yet there is no kind:0 to consult, so this local marker is
 * the only evidence of "brand new here".
 */
export function markFreshIdentity(
  pubkey: string,
  storage: StorageLike | null = ambientStorage(),
): void {
  storage?.setItem(freshIdentityKey(pubkey), "true");
}

export function clearFreshIdentity(
  pubkey: string,
  storage: StorageLike | null = ambientStorage(),
): void {
  storage?.removeItem(freshIdentityKey(pubkey));
}

/**
 * Did this identity sign up on this machine?
 *
 * The marker alone, without the "and has not finished onboarding yet" clause
 * {@link isFreshFounder} adds. Surfaces that greet a founder *after* first run
 * need this one: by the time they reach their workspace the completion key is
 * written, so `isFreshFounder` is already false and would treat a founder five
 * seconds past signup exactly like a five-year veteran.
 *
 * Nothing clears the marker, which is the point: it records how this identity
 * arrived, and that does not change later.
 */
export function isFreshFounderIdentity(
  pubkey: string | null | undefined,
  storage: StorageLike | null = ambientStorage(),
): boolean {
  if (!pubkey || !storage) return false;
  return storage.getItem(freshIdentityKey(pubkey)) === "true";
}

/**
 * Should this boot run the canvas first run instead of WelcomeSetup?
 *
 * `hasOwnCommunity` must be scoped to the pubkey signing up, not to the
 * machine as a whole: a machine can carry a community from an entirely
 * different, earlier identity, and that must not disqualify a second,
 * genuinely new identity from the canvas flow. A previous version of this
 * check took a machine-wide community count, which meant a second signup on
 * a non-empty machine fell through to the legacy OnboardingFlow even though
 * the signing-up pubkey had never been onboarded.
 */
export function isFreshFounder({
  pubkey,
  hasOwnCommunity,
  storage = ambientStorage(),
}: {
  pubkey: string | null;
  hasOwnCommunity: boolean;
  storage?: StorageLike | null;
}): boolean {
  if (!pubkey || hasOwnCommunity || !storage) return false;
  if (storage.getItem(freshIdentityKey(pubkey)) !== "true") return false;
  return storage.getItem(onboardingCompletionStorageKey(pubkey)) !== "true";
}
