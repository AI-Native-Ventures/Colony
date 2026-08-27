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

/** Should this boot run the canvas first run instead of WelcomeSetup? */
export function isFreshFounder({
  pubkey,
  communitiesCount,
  storage = ambientStorage(),
}: {
  pubkey: string | null;
  communitiesCount: number;
  storage?: StorageLike | null;
}): boolean {
  if (!pubkey || communitiesCount > 0 || !storage) return false;
  if (storage.getItem(freshIdentityKey(pubkey)) !== "true") return false;
  return storage.getItem(onboardingCompletionStorageKey(pubkey)) !== "true";
}
