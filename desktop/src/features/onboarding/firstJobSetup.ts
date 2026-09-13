import {
  FIRST_JOB_SUGGESTION_MARKER,
  canStartFirstJobSuggestion,
} from "./firstJobSuggestion";
import { SCOUT_ONBOARDING_ROOT_MARKER } from "./channelOnboardingRuntime/protocol";

/** The owner and exact community that opted into explicit first-job Start. */
export type FirstJobSetupScope = { ownerPubkey: string; relayUrl: string };
/** Unknown storage must never enable the legacy automatic agent kickoff. */
export type FirstJobSetupStatus = "explicit" | "legacy" | "unavailable";
const PREFIX = "colony.first-job-setup.v1:";
const CHANGE_EVENT = "colony-first-job-setup-changed";

/** Stable, checked owner/community key; no secrets are persisted. */
export function firstJobSetupKey(scope: FirstJobSetupScope): string {
  const relay = new URL(scope.relayUrl);
  if (
    !/^[a-f0-9]{64}$/.test(scope.ownerPubkey) ||
    scope.relayUrl.length > 2048 ||
    !["ws:", "wss:"].includes(relay.protocol) ||
    !relay.hostname ||
    relay.username ||
    relay.password ||
    relay.hash
  )
    throw new Error("This business connection could not be verified.");
  return `${PREFIX}${JSON.stringify([scope.ownerPubkey, scope.relayUrl])}`;
}

/** Injected storage makes durable opt-in and read failures independently testable. */
export function createFirstJobSetupStore(
  storage: Pick<Storage, "getItem" | "setItem">,
  notify?: () => void,
) {
  return {
    read(scope: FirstJobSetupScope): FirstJobSetupStatus {
      try {
        const raw = storage.getItem(firstJobSetupKey(scope));
        if (raw === null) return "legacy";
        return raw ===
          JSON.stringify({ version: 1, ...scope, mode: "explicit" })
          ? "explicit"
          : "unavailable";
      } catch {
        return "unavailable";
      }
    },
    mark(scope: FirstJobSetupScope): void {
      const key = firstJobSetupKey(scope);
      const raw = JSON.stringify({ version: 1, ...scope, mode: "explicit" });
      try {
        storage.setItem(key, raw);
        if (storage.getItem(key) !== raw)
          throw new Error("Write was not retained");
      } catch {
        throw new Error(
          "Colony could not save this setup step. Free some storage and try again.",
        );
      }
      notify?.();
    },
  };
}

/** Save explicit Start before channel creation can mount the legacy Welcome hook. */
export function markExplicitFirstJobSetup(scope: FirstJobSetupScope): void {
  createFirstJobSetupStore(globalThis.localStorage, () => {
    globalThis.dispatchEvent?.(new Event(CHANGE_EVENT));
  }).mark(scope);
}

/** Synchronous, fail-closed snapshot for the Welcome effect gate. */
export function readFirstJobSetupStatus(
  scope: FirstJobSetupScope,
): FirstJobSetupStatus {
  try {
    return createFirstJobSetupStore(globalThis.localStorage).read(scope);
  } catch {
    return "unavailable";
  }
}

/** Listen to same-window and cross-window opt-in changes. */
export function subscribeFirstJobSetup(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(PREFIX)) listener();
  };
  globalThis.addEventListener?.(CHANGE_EVENT, listener);
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    globalThis.removeEventListener?.(CHANGE_EVENT, listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

/** Existing accepted suggestion roots also disable automatic legacy work on another device. */
export function suppressLegacyFirstJobKickoff(
  status: FirstJobSetupStatus,
  scope: FirstJobSetupScope & { channelId: string },
  events: readonly {
    id: string;
    kind: number;
    pubkey: string;
    tags: string[][];
  }[],
): boolean {
  return (
    status !== "legacy" ||
    events.some(
      (event) =>
        event.tags.some(
          (tag) =>
            tag[0] === "client" && tag[1] === SCOUT_ONBOARDING_ROOT_MARKER,
        ) ||
        canStartFirstJobSuggestion(
          { ...event, signerPubkey: event.pubkey },
          scope,
        ),
    )
  );
}

/** A truncated history page or a failed read never authorizes automatic paid work. */
export async function allowLegacyFirstJobKickoff(
  readHistory: () => Promise<readonly { tags: string[][] }[]>,
): Promise<boolean> {
  try {
    const events = await readHistory();
    return (
      events.length < 500 &&
      !events.some((event) =>
        event.tags.some(
          (tag) =>
            tag[0] === "client" &&
            (tag[1] === FIRST_JOB_SUGGESTION_MARKER ||
              tag[1] === SCOUT_ONBOARDING_ROOT_MARKER),
        ),
      )
    );
  } catch {
    return false;
  }
}
