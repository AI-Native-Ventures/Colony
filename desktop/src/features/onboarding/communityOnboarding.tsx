import {
  deriveCommunityName,
  normalizeRelayUrl,
} from "@/features/communities/communityStorage";
import { setLocalStorageItemWithRecovery } from "@/shared/lib/localStorageQuota";
import type { Profile } from "@/shared/api/types";
import {
  createAdditionalCommunityOnboardingV2Draft,
  createOnboardingV2Draft,
  migrateOnboardingV2Draft,
  type OnboardingV2Draft,
} from "./onboardingV2";

const STORAGE_KEY = "buzz-community-onboarding-transaction.v1";

/**
 * A transaction parked in "finalizing" is mid-handoff. If it is still there
 * after this long, the handoff died without settling (e.g. the relay never
 * answered) and replaying the curtain on every launch would trap the user
 * out of their own communities. Sweep it on load instead.
 */
const FINALIZING_STALE_AFTER_MS = 2 * 60 * 1000;

export function finalizingTransactionIsStale(
  transaction: Pick<CommunityOnboardingTransaction, "stage" | "updatedAt">,
  now = Date.now(),
): boolean {
  if (transaction.stage !== "finalizing") return false;
  const updatedAt = Date.parse(transaction.updatedAt);
  if (Number.isNaN(updatedAt)) return true;
  return now - updatedAt > FINALIZING_STALE_AFTER_MS;
}

export type CommunityOnboardingSource =
  | "first-community"
  | "create-community"
  | "add-community"
  | "membership-recovery"
  | "deep-link-connect"
  | "deep-link-join";

export type CommunityOnboardingStage =
  | "claiming"
  | "connecting"
  | "profile"
  | "team-intro"
  | "finalizing"
  /**
   * Backend setup is done and the app is mounting directly on the Welcome
   * channel underneath the onboarding screen, which stays up as an opaque
   * curtain until Welcome reports settled (or a safety timeout), then fades.
   */
  | "entering";

export type FirstCommunityPage = "join" | "member" | "owned";

export type CommunityOnboardingTransaction = {
  id: string;
  source: CommunityOnboardingSource;
  /** First-run screen that launched this transaction, restored on cancel. */
  firstCommunityPage?: FirstCommunityPage;
  stage: CommunityOnboardingStage;
  relayUrl: string;
  inviteCode?: string;
  communityName: string;
  token?: string;
  reposDir?: string;
  /**
   * Join-policy acceptance receipt minted before the claim (bound to the
   * invite code). Forwarded to `claimInvite` so relays with a configured
   * join policy admit the claim.
   */
  policyReceipt?: string;
  communityId?: string;
  previousCommunityId?: string;
  addedCommunity?: boolean;
  createdAt: string;
  updatedAt: string;
  error?: string;
  // Deep links are persisted before machine onboarding completes. Set when
  // the user dismisses the acknowledgment so it stays dismissed on relaunch.
  acknowledged?: boolean;
  /** Durable company-creation journey. Never created for join flows. */
  onboardingV2?: OnboardingV2Draft;
};

export type CommunityOnboardingTransactionPatch = Partial<
  Pick<
    CommunityOnboardingTransaction,
    | "stage"
    | "relayUrl"
    | "communityId"
    | "previousCommunityId"
    | "addedCommunity"
    | "communityName"
    | "error"
    | "acknowledged"
    | "onboardingV2"
  >
>;

export type StartCommunityOnboardingInput = {
  source: CommunityOnboardingSource;
  firstCommunityPage?: FirstCommunityPage;
  relayUrl: string;
  inviteCode?: string;
  communityName?: string;
  token?: string;
  reposDir?: string;
  policyReceipt?: string;
};

function canonicalRelayUrl(rawRelayUrl: string) {
  const trimmed = rawRelayUrl.trim();
  const withScheme = /^(ws|wss):\/\//i.test(trimmed)
    ? trimmed
    : normalizeRelayUrl(trimmed);
  const parsed = new URL(withScheme);
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

function isTransaction(
  value: unknown,
): value is CommunityOnboardingTransaction {
  if (!value || typeof value !== "object") return false;
  const transaction = value as Partial<CommunityOnboardingTransaction>;
  return (
    typeof transaction.id === "string" &&
    typeof transaction.relayUrl === "string" &&
    typeof transaction.communityName === "string" &&
    typeof transaction.createdAt === "string" &&
    typeof transaction.updatedAt === "string" &&
    [
      "claiming",
      "connecting",
      "profile",
      "team-intro",
      "finalizing",
      "entering",
    ].includes(transaction.stage ?? "")
    // onboardingV2 is deliberately not validated here: persisted drafts from
    // older builds must survive the load path so migrateOnboardingV2Draft can
    // carry them forward.
  );
}

export function loadCommunityOnboardingTransaction(
  storage: Storage = localStorage,
): CommunityOnboardingTransaction | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isTransaction(parsed)) return null;
    if (finalizingTransactionIsStale(parsed)) {
      // The community itself was already added and activated; dropping the
      // transaction lands the user inside the app instead of replaying a
      // dead handoff forever.
      storage.removeItem(STORAGE_KEY);
      return null;
    }
    if (parsed.onboardingV2 !== undefined) {
      // Drafts predate the stage-machine rework sometimes (app upgraded
      // mid-onboarding). Migrate what was captured instead of replaying old
      // steps; an unusable draft restarts its journey rather than falling
      // back to the join flow.
      const migrated = migrateOnboardingV2Draft(parsed.onboardingV2);
      const fallbackDraft =
        parsed.source === "first-community"
          ? createOnboardingV2Draft()
          : createAdditionalCommunityOnboardingV2Draft();
      const repaired = { ...parsed, onboardingV2: migrated ?? fallbackDraft };
      if (repaired.onboardingV2 !== parsed.onboardingV2) {
        saveCommunityOnboardingTransaction(repaired, storage);
      }
      return repaired;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveCommunityOnboardingTransaction(
  transaction: CommunityOnboardingTransaction,
  storage: Storage = localStorage,
): void {
  if (typeof localStorage !== "undefined" && storage === localStorage) {
    setLocalStorageItemWithRecovery(STORAGE_KEY, JSON.stringify(transaction));
  } else {
    storage.setItem(STORAGE_KEY, JSON.stringify(transaction));
  }
}

export function clearCommunityOnboardingTransaction(
  storage: Storage = localStorage,
): void {
  storage.removeItem(STORAGE_KEY);
}

export function startCommunityOnboarding(
  input: StartCommunityOnboardingInput,
  storage: Storage = localStorage,
  now = new Date(),
): CommunityOnboardingTransaction {
  const relayUrl = canonicalRelayUrl(input.relayUrl);
  const existing = loadCommunityOnboardingTransaction(storage);
  if (existing?.relayUrl === relayUrl) {
    const updated = {
      ...existing,
      firstCommunityPage:
        input.firstCommunityPage ?? existing.firstCommunityPage,
      inviteCode: input.inviteCode?.trim() || existing.inviteCode,
      communityName: input.communityName?.trim() || existing.communityName,
      token: input.token?.trim() || existing.token,
      reposDir: input.reposDir ?? existing.reposDir,
      policyReceipt: input.policyReceipt ?? existing.policyReceipt,
      updatedAt: now.toISOString(),
      error: undefined,
      // A freshly opened link deserves fresh feedback — re-present the gate
      // even if a previous link for this relay was already dismissed.
      acknowledged: undefined,
    };
    saveCommunityOnboardingTransaction(updated, storage);
    return updated;
  }

  const timestamp = now.toISOString();
  const transaction: CommunityOnboardingTransaction = {
    id: crypto.randomUUID(),
    source: input.source,
    firstCommunityPage: input.firstCommunityPage,
    stage: input.inviteCode?.trim() ? "claiming" : "connecting",
    relayUrl,
    inviteCode: input.inviteCode?.trim() || undefined,
    communityName: input.communityName?.trim() || deriveCommunityName(relayUrl),
    token: input.token?.trim() || undefined,
    reposDir: input.reposDir,
    policyReceipt: input.policyReceipt,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(input.source === "first-community" && {
      onboardingV2: createOnboardingV2Draft(),
    }),
    ...(input.source === "create-community" && {
      onboardingV2: createAdditionalCommunityOnboardingV2Draft(),
    }),
  };
  saveCommunityOnboardingTransaction(transaction, storage);
  return transaction;
}

export function updateCommunityOnboardingTransaction(
  transaction: CommunityOnboardingTransaction,
  patch: CommunityOnboardingTransactionPatch,
  storage: Storage = localStorage,
  now = new Date(),
): CommunityOnboardingTransaction {
  const updated = { ...transaction, ...patch, updatedAt: now.toISOString() };
  saveCommunityOnboardingTransaction(updated, storage);
  return updated;
}

export function updateCurrentCommunityOnboardingTransaction(
  current: CommunityOnboardingTransaction | null,
  patch: CommunityOnboardingTransactionPatch,
  expectedId: string | undefined,
  storage: Storage = localStorage,
  now = new Date(),
): CommunityOnboardingTransaction | null {
  if (!current || (expectedId && current.id !== expectedId)) return current;
  return updateCommunityOnboardingTransaction(current, patch, storage, now);
}

export function shouldForceFirstCommunityJourney(
  transaction: CommunityOnboardingTransaction,
): boolean {
  return (
    transaction.source === "first-community" &&
    transaction.onboardingV2 !== undefined
  );
}

/**
 * Whether this transaction is the owner setting up a community of their own,
 * which is the only journey allowed to write this device's agent defaults.
 *
 * A joiner is not who Colony provisions for. Their agents would be pointed at
 * a Colony Credits account nobody funded on a relay somebody else owns, so
 * onboarding would have swapped a Settings errand for an agent that pauses at
 * $0.00 on its first turn. `first-community` covers joining as well as owning,
 * hence the page check: only the "owned" page creates a community, or
 * reconnects one the signer already owns.
 */
export function isOwnerLedCommunityOnboarding(
  transaction: CommunityOnboardingTransaction,
): boolean {
  if (transaction.source === "create-community") return true;
  return (
    transaction.source === "first-community" &&
    transaction.firstCommunityPage === "owned"
  );
}

export function markCommunityOnboardingComplete(
  pubkey: string,
  relayUrl: string,
  storage: Storage = localStorage,
): void {
  storage.setItem(
    `buzz-community-onboarding-complete.v1:${encodeURIComponent(relayUrl)}:${pubkey}`,
    "true",
  );
  // The legacy gate is identity-scoped. Marking it here prevents the old profile
  // flow from reopening after the first community transaction completes.
  storage.setItem(`buzz-onboarding-complete.v1:${pubkey}`, "true");
}

/**
 * Returns true when a relay-profile check result means the user should skip
 * community onboarding entirely and land directly in the app.
 *
 * A profile fetch error is represented as `null` and always returns false so
 * that the fallback (show the profile step) applies — the skip must never
 * block or strand onboarding.
 */
export function shouldSkipCommunityOnboarding(
  profile: Profile | null,
): boolean {
  return profile !== null && profile.hasProfileEvent === true;
}

/**
 * Outcome of a profile-check attempt during the connecting → profile
 * transition. Produced by `resolveProfileCheckAction`.
 *
 * - `{ action: "skip", profile }` — kind:0 exists; mark complete and enter
 *   the app. The resolved `Profile` is included so callers have the pubkey
 *   for `markCommunityOnboardingComplete` without a second fetch.
 * - `{ action: "show-profile" }` — no kind:0, or the fetch failed / timed
 *   out; show the profile setup step.
 */
export type ProfileCheckAction =
  | { action: "skip"; profile: Profile }
  | { action: "show-profile" };

/**
 * Returns true when a live transaction snapshot still represents the
 * same connecting request that launched the profile check.
 *
 * Extracted as a pure predicate so the stale-result guard in App.tsx can
 * be unit-tested without mounting a component.
 */
export function isTransactionStillConnecting(
  live: CommunityOnboardingTransaction | null | undefined,
  transactionId: string,
): boolean {
  return live?.id === transactionId && live.stage === "connecting";
}

/**
 * Runs a bounded profile fetch and returns the action to take at the
 * `connecting → profile` transition.
 *
 * Accepts `fetchProfile`, `timeoutMs`, and `scheduleTimeout` as parameters so
 * callers (and tests) can supply controlled implementations. `scheduleTimeout`
 * must return a cancellation handle (like `window.setTimeout`) so the timer
 * can be cleared when the fetch settles before the deadline.
 *
 * Any fetch error or timeout → `{ action: "show-profile" }` (never strands
 * onboarding).
 */
export async function resolveProfileCheckAction(
  fetchProfile: () => Promise<Profile>,
  timeoutMs: number,
  scheduleTimeout: (
    fn: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout> = (fn, ms) => window.setTimeout(fn, ms),
): Promise<ProfileCheckAction> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  try {
    const profile = await Promise.race([
      fetchProfile(),
      new Promise<never>(
        (_, reject) =>
          (timerId = scheduleTimeout(
            () => reject(new Error("profile-check-timeout")),
            timeoutMs,
          )),
      ),
    ]);
    return shouldSkipCommunityOnboarding(profile)
      ? { action: "skip", profile }
      : { action: "show-profile" };
  } catch {
    return { action: "show-profile" };
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
  }
}

import * as React from "react";

type CommunityOnboardingContextValue = {
  transaction: CommunityOnboardingTransaction | null;
  start: (input: StartCommunityOnboardingInput) => boolean;
  update: (
    patch: CommunityOnboardingTransactionPatch,
    expectedId?: string,
  ) => void;
  clear: () => void;
};

const CommunityOnboardingContext =
  React.createContext<CommunityOnboardingContextValue | null>(null);

export function CommunityOnboardingProvider({
  children,
  enabled = true,
}: {
  children: React.ReactNode;
  enabled?: boolean;
}) {
  const [transaction, setTransaction] = React.useState(() =>
    enabled ? loadCommunityOnboardingTransaction() : null,
  );
  const start = React.useCallback(
    (input: StartCommunityOnboardingInput) => {
      if (!enabled) return false;
      if (
        transaction &&
        canonicalRelayUrl(input.relayUrl) !== transaction.relayUrl
      ) {
        return false;
      }
      setTransaction(startCommunityOnboarding(input));
      return true;
    },
    [enabled, transaction],
  );
  const update = React.useCallback(
    (patch: CommunityOnboardingTransactionPatch, expectedId?: string) => {
      if (!enabled) return;
      setTransaction((current) =>
        updateCurrentCommunityOnboardingTransaction(current, patch, expectedId),
      );
    },
    [enabled],
  );
  const clear = React.useCallback(() => {
    if (!enabled) return;
    clearCommunityOnboardingTransaction();
    setTransaction(null);
  }, [enabled]);
  const value = React.useMemo(
    () => ({ transaction, start, update, clear }),
    [clear, start, transaction, update],
  );
  return (
    <CommunityOnboardingContext.Provider value={value}>
      {children}
    </CommunityOnboardingContext.Provider>
  );
}

export function useCommunityOnboarding() {
  const context = React.useContext(CommunityOnboardingContext);
  if (!context)
    throw new Error(
      "useCommunityOnboarding must be used within CommunityOnboardingProvider",
    );
  return context;
}
