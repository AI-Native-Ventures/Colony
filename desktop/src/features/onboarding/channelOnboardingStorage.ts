/**
 * Durable state for the inline Scout onboarding fragment.
 *
 * The relay is the source of truth for the signed records. This store only
 * keeps a route draft and the exact signed values needed to finish a request
 * after an interrupted renderer or an uncertain relay acknowledgement.
 */

export type ChannelOnboardingScope = Readonly<{
  ownerPubkey: string;
  relayUrl: string;
  channelId: string;
  threadRootId: string;
  requestId: string;
}>;

export type ChannelOnboardingStorageDependencies = {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  /** A real Web Lock is required when more than one app window can resume. */
  withLock<T>(name: string, work: () => Promise<T>): Promise<T>;
  notify?: (key: string) => void;
};

type StoredValue<T> = {
  version: 1;
  scope: ChannelOnboardingScope;
  value: T;
};

const KEY_PREFIX = "colony.scout-channel-onboarding.v1:";
const MAX_VALUE_LENGTH = 131_072;
const PUBKEY = /^[a-f0-9]{64}$/;
const EVENT_ID = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const SLOT = /^[a-z-]{1,48}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRelayUrl(value: string) {
  try {
    const relay = new URL(value);
    return (
      ["ws:", "wss:"].includes(relay.protocol) &&
      relay.hostname.length > 0 &&
      relay.username === "" &&
      relay.password === "" &&
      relay.hash === "" &&
      value.length <= 2_048
    );
  } catch {
    return false;
  }
}

/** Validate and freeze the exact identity/community/root tuple. */
export function snapshotChannelOnboardingScope(
  scope: ChannelOnboardingScope,
): ChannelOnboardingScope {
  if (
    !PUBKEY.test(scope.ownerPubkey) ||
    !EVENT_ID.test(scope.threadRootId) ||
    !ID.test(scope.channelId) ||
    !ID.test(scope.requestId) ||
    !validRelayUrl(scope.relayUrl)
  ) {
    throw new Error(
      "This Scout setup belongs to a different account or business. Reopen the original Welcome thread.",
    );
  }
  return Object.freeze({
    ownerPubkey: scope.ownerPubkey,
    relayUrl: scope.relayUrl,
    channelId: scope.channelId,
    threadRootId: scope.threadRootId,
    requestId: scope.requestId,
  });
}

/** JSON tuple key: delimiters in a relay URL cannot collide with a field. */
export function channelOnboardingStorageKey(
  scope: ChannelOnboardingScope,
  slot: string,
) {
  const captured = snapshotChannelOnboardingScope(scope);
  if (!SLOT.test(slot)) {
    throw new Error("This Scout setup storage slot is invalid.");
  }
  return `${KEY_PREFIX}${JSON.stringify([
    captured.ownerPubkey,
    captured.relayUrl,
    captured.channelId,
    captured.threadRootId,
    captured.requestId,
    slot,
  ])}`;
}

function isScope(value: unknown): value is ChannelOnboardingScope {
  if (!isRecord(value)) return false;
  try {
    snapshotChannelOnboardingScope(value as ChannelOnboardingScope);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a storage adapter with injectable browser primitives.
 *
 * Read failures are intentionally distinct from an absent value. A malformed
 * attempt must never turn into a new signed request with a new idempotency
 * key, since that could publish twice after the original write actually won.
 */
export function createChannelOnboardingStore<T>(
  dependencies: ChannelOnboardingStorageDependencies,
  slot: string,
  validate: (value: unknown) => value is T,
) {
  function read(scope: ChannelOnboardingScope): T | null {
    const key = channelOnboardingStorageKey(scope, slot);
    const raw = dependencies.storage.getItem(key);
    if (raw === null) return null;
    try {
      if (raw.length > MAX_VALUE_LENGTH) throw new Error("oversized value");
      const item: Partial<StoredValue<unknown>> = JSON.parse(raw);
      if (
        item.version !== 1 ||
        !isScope(item.scope) ||
        channelOnboardingStorageKey(item.scope, slot) !== key ||
        !validate(item.value)
      ) {
        throw new Error("invalid value");
      }
      return item.value;
    } catch {
      throw new Error(
        "Colony could not read the saved Scout setup. It has not started another request.",
      );
    }
  }

  function write(scope: ChannelOnboardingScope, value: T) {
    const captured = snapshotChannelOnboardingScope(scope);
    const key = channelOnboardingStorageKey(captured, slot);
    if (!validate(value)) {
      throw new Error("This Scout setup update could not be verified.");
    }
    const raw = JSON.stringify({
      version: 1,
      scope: captured,
      value,
    } satisfies StoredValue<T>);
    if (raw.length > MAX_VALUE_LENGTH) {
      throw new Error("This Scout setup update is too large to save.");
    }
    try {
      dependencies.storage.setItem(key, raw);
      if (dependencies.storage.getItem(key) !== raw) {
        throw new Error("write was not retained");
      }
    } catch {
      throw new Error(
        "Colony could not save this Scout setup. Keep the thread open and try again; the existing request will be checked.",
      );
    }
    dependencies.notify?.(key);
  }

  function remove(scope: ChannelOnboardingScope) {
    const key = channelOnboardingStorageKey(scope, slot);
    dependencies.storage.removeItem(key);
    dependencies.notify?.(key);
  }

  return {
    read,
    write,
    remove,
    withLock<R>(scope: ChannelOnboardingScope, work: () => Promise<R>) {
      return dependencies.withLock(
        channelOnboardingStorageKey(scope, slot),
        work,
      );
    },
  };
}

/** Fail closed when Web Locks are unavailable instead of pretending a lock exists. */
export function withChannelOnboardingBrowserLock<T>(
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!globalThis.navigator?.locks) {
    return Promise.reject(
      new Error(
        "This version of Colony cannot safely resume Scout setup. Update the app and try again.",
      ),
    );
  }
  return navigator.locks.request(name, { mode: "exclusive" }, work);
}

/** The renderer store used by the real host. It is lazy so focused Node tests need no DOM. */
export function createChannelOnboardingBrowserStore<T>(
  slot: string,
  validate: (value: unknown) => value is T,
) {
  const storage = globalThis.localStorage;
  if (!storage) {
    throw new Error("Scout setup storage is unavailable in this window.");
  }
  return createChannelOnboardingStore(
    {
      storage,
      withLock: withChannelOnboardingBrowserLock,
      notify: (key) => {
        globalThis.dispatchEvent?.(
          new CustomEvent("colony-scout-channel-onboarding-changed", {
            detail: { key },
          }),
        );
      },
    },
    slot,
    validate,
  );
}

export const SCOUT_ONBOARDING_DRAFT_SLOT = "draft";
export const SCOUT_ONBOARDING_ATTEMPT_SLOT = "attempt";
