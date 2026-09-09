import type { CommunityOnboardingTransaction } from "./communityOnboarding";
import { migrateOnboardingV2Draft } from "./onboardingV2";

const PREFIX = "colony.business-onboarding.v1:";

/** Canonical owner/community coordinate; display names never identify a run. */
export function businessOnboardingKey(
  ownerPubkey: string,
  relayUrl: string,
): string {
  const relay = new URL(relayUrl);
  if (
    !/^[a-f0-9]{64}$/.test(ownerPubkey) ||
    !["ws:", "wss:"].includes(relay.protocol) ||
    relay.username ||
    relay.password ||
    relay.hash
  )
    throw new Error("The account or business could not be verified.");
  relay.pathname = relay.pathname.replace(/\/+$/, "") || "/";
  return `${PREFIX}${JSON.stringify([ownerPubkey, relay.toString().replace(/\/$/, "")])}`;
}

/** Retain unfinished business setup separately from the active connection walk. */
export function savePendingBusinessOnboarding(
  transaction: CommunityOnboardingTransaction,
  storage: Storage,
): void {
  if (transaction.source !== "create-community" || !transaction.ownerPubkey)
    return;
  const key = businessOnboardingKey(
    transaction.ownerPubkey,
    transaction.relayUrl,
  );
  const raw = JSON.stringify(transaction);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw)
    throw new Error(
      "Colony could not retain this business setup. Free some storage and try again.",
    );
}

/** Read only the requested owner's business; corrupted progress is not an empty draft. */
export function loadPendingBusinessOnboarding(
  ownerPubkey: string,
  relayUrl: string,
  storage: Storage = localStorage,
): CommunityOnboardingTransaction | null {
  const key = businessOnboardingKey(ownerPubkey, relayUrl);
  const raw = storage.getItem(key);
  if (!raw) return null;
  const value = JSON.parse(raw) as CommunityOnboardingTransaction;
  if (
    !value ||
    ![
      "claiming",
      "connecting",
      "profile",
      "team-intro",
      "finalizing",
      "entering",
    ].includes(value.stage) ||
    value.source !== "create-community" ||
    value.ownerPubkey !== ownerPubkey ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.communityName !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    businessOnboardingKey(value.ownerPubkey, value.relayUrl) !== key
  )
    throw new Error("This saved business setup could not be verified.");
  if (value.onboardingV2 !== undefined) {
    const migrated = migrateOnboardingV2Draft(value.onboardingV2);
    if (!migrated)
      throw new Error("This saved business draft could not be recovered.");
    return { ...value, onboardingV2: migrated };
  }
  return value;
}

/** Remove only the completed run, never a replacement saved for the same business. */
export function removePendingBusinessOnboarding(
  transaction: CommunityOnboardingTransaction,
  storage: Storage,
): void {
  if (transaction.source !== "create-community" || !transaction.ownerPubkey)
    return;
  const saved = loadPendingBusinessOnboarding(
    transaction.ownerPubkey,
    transaction.relayUrl,
    storage,
  );
  if (saved?.id === transaction.id)
    storage.removeItem(
      businessOnboardingKey(transaction.ownerPubkey, transaction.relayUrl),
    );
}

/** An identity change cannot adopt a business creation transaction. */
export function transactionBelongsToOwner(
  transaction: CommunityOnboardingTransaction | null,
  ownerPubkey: string | null | undefined,
): boolean {
  return (
    !!transaction &&
    (transaction.ownerPubkey
      ? transaction.ownerPubkey === ownerPubkey
      : transaction.source !== "create-community")
  );
}
