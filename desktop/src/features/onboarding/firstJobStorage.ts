import type { FirstJobScope } from "./firstJobStart";

type StoreScope = FirstJobScope;
type StoredValue<T> = { version: 1; scope: StoreScope; value: T };

/** Durable, root-scoped draft/retry data. Canonical work lives on the relay. */
export type FirstJobStorageDependencies = {
  storage: Pick<Storage, "getItem" | "setItem">;
  /** Required browser Web Lock; an in-memory lock cannot protect another window. */
  withLock<T>(name: string, work: () => Promise<T>): Promise<T>;
  notify?: (key: string) => void;
};

/** An exact identity/community/root tuple, without delimiter collisions. */
export function firstJobStorageKey(scope: StoreScope, slot: string): string {
  if (
    !/^[a-f0-9]{64}$/.test(scope.ownerPubkey) ||
    !/^[a-f0-9]{64}$/.test(scope.threadRootId) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(scope.channelId) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(scope.requestId) ||
    !/^[a-z-]{1,40}$/.test(slot)
  )
    throw new Error(
      "This first-job context is invalid. Reopen its original thread.",
    );
  let relay: URL;
  try {
    relay = new URL(scope.relayUrl);
  } catch {
    throw new Error("This business connection is invalid.");
  }
  if (
    !["ws:", "wss:"].includes(relay.protocol) ||
    !relay.hostname ||
    relay.username ||
    relay.password ||
    relay.hash ||
    scope.relayUrl.length > 2048
  )
    throw new Error("This business connection is invalid.");
  return `colony.first-job.v1:${JSON.stringify([
    scope.ownerPubkey,
    scope.relayUrl,
    scope.channelId,
    scope.threadRootId,
    scope.requestId,
    slot,
  ])}`;
}

/** Read failures are distinct from an absent attempt: never silently start again. */
export function createFirstJobStore<T>(
  dependencies: FirstJobStorageDependencies,
  slot: string,
  validate: (value: unknown) => value is T,
) {
  function read(scope: StoreScope): T | null {
    const key = firstJobStorageKey(scope, slot);
    const raw = dependencies.storage.getItem(key);
    if (raw === null) return null;
    try {
      if (raw.length > 131_072) throw new Error("Oversized attempt");
      const item = JSON.parse(raw) as Partial<StoredValue<unknown>>;
      if (
        item?.version !== 1 ||
        !item.scope ||
        firstJobStorageKey(item.scope, slot) !== key ||
        !validate(item.value)
      )
        throw new Error("Invalid attempt");
      return item.value;
    } catch {
      throw new Error(
        "Colony could not read the saved first-job attempt. It has not started another one.",
      );
    }
  }

  function write(scope: StoreScope, value: T): void {
    const key = firstJobStorageKey(scope, slot);
    if (!validate(value))
      throw new Error("This first-job update could not be saved.");
    const raw = JSON.stringify({
      version: 1,
      scope,
      value,
    } satisfies StoredValue<T>);
    if (raw.length > 131_072)
      throw new Error("This first-job update is too large to save.");
    try {
      dependencies.storage.setItem(key, raw);
      if (dependencies.storage.getItem(key) !== raw)
        throw new Error("Write was not retained");
    } catch {
      throw new Error(
        "Colony could not save this step. Keep this thread open, free some storage and try again; the existing attempt will be checked.",
      );
    }
    dependencies.notify?.(key);
  }

  return {
    read,
    write,
    withLock<R>(scope: StoreScope, work: () => Promise<R>): Promise<R> {
      return dependencies.withLock(firstJobStorageKey(scope, slot), work);
    },
  };
}

/** Fail visibly when durable cross-window locking is unavailable. */
export function withFirstJobBrowserLock<T>(
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!globalThis.navigator?.locks) {
    return Promise.reject(
      new Error(
        "This version of Colony cannot safely resume this job. Update the app and try again.",
      ),
    );
  }
  return navigator.locks.request(name, { mode: "exclusive" }, work);
}
