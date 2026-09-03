// desktop/src/features/onboarding/freshFounder.ts
import { onboardingCompletionStorageKey } from "./completionKey";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const FRESH_IDENTITY_KEY_PREFIX = "colony.identity.fresh";
const FOUNDER_RUN_KEY_PREFIX = "colony.founder.run";

function freshIdentityKey(pubkey: string): string {
  return `${FRESH_IDENTITY_KEY_PREFIX}:${pubkey}`;
}

function founderRunKey(pubkey: string): string {
  return `${FOUNDER_RUN_KEY_PREFIX}:${pubkey}`;
}

/**
 * Written when someone who already has an identity asks to create a
 * community ("Create a community" on the workspace choice screen).
 *
 * The fresh-identity marker cannot answer this: that one means "this key was
 * made moments ago", and the person here has had theirs for months, possibly
 * with a finished onboarding behind them. What they are asking for is the
 * founder walk, minus the two screens that make an account, so the request is
 * recorded as itself. It survives a relaunch mid-run, and the run clears it.
 */
export function markFounderRunRequested(
  pubkey: string,
  storage: StorageLike | null = ambientStorage(),
): void {
  storage?.setItem(founderRunKey(pubkey), "true");
}

export function clearFounderRunRequested(
  pubkey: string,
  storage: StorageLike | null = ambientStorage(),
): void {
  storage?.removeItem(founderRunKey(pubkey));
}

export function isFounderRunRequested(
  pubkey: string | null,
  storage: StorageLike | null = ambientStorage(),
): boolean {
  if (!pubkey || !storage) return false;
  return storage.getItem(founderRunKey(pubkey)) === "true";
}

/**
 * Should this boot run the canvas founder walk?
 *
 * Two ways in: a brand-new identity that has just signed up, and an existing
 * identity that asked to create a community. Both claim a workspace, which is
 * a step of the walk itself, so both belong to the same flow; they differ
 * only in whether the account and recovery screens are on the path.
 */
export function shouldRunCanvasFirstRun(args: {
  pubkey: string | null;
  hasOwnCommunity: boolean;
  storage?: StorageLike | null;
}): boolean {
  const storage = args.storage ?? ambientStorage();
  if (!args.pubkey || args.hasOwnCommunity || !storage) return false;
  return (
    isFounderRunRequested(args.pubkey, storage) ||
    isFreshFounder({ ...args, storage })
  );
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
