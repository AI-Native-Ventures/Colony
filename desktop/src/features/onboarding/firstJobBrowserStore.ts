import type { FirstJobScope } from "./firstJobStart";
import {
  createFirstJobStore,
  firstJobStorageKey,
  withFirstJobBrowserLock,
} from "./firstJobStorage";

const CHANGE_EVENT = "colony:first-job-storage";

/** Shared updates for the channel, right-hand thread and other app windows. */
export function createFirstJobBrowserStore<T>(
  slot: string,
  validate: (value: unknown) => value is T,
) {
  const store = createFirstJobStore(
    {
      // Deliberately not safeStorage's null fallback: an unreadable attempt must
      // not look like an empty attempt that can safely be started again.
      storage: {
        getItem: (key) => window.localStorage.getItem(key),
        setItem: (key, value) => window.localStorage.setItem(key, value),
      },
      withLock: withFirstJobBrowserLock,
      notify: (key) =>
        window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: key })),
    },
    slot,
    validate,
  );
  return {
    ...store,
    subscribe(scope: FirstJobScope, listener: () => void): () => void {
      const key = firstJobStorageKey(scope, slot);
      const changed = (event: Event) => {
        if ((event as CustomEvent<string>).detail === key) listener();
      };
      const storageChanged = (event: StorageEvent) => {
        if (
          event.storageArea === window.localStorage &&
          (event.key === key || event.key === null)
        )
          listener();
      };
      window.addEventListener(CHANGE_EVENT, changed);
      window.addEventListener("storage", storageChanged);
      return () => {
        window.removeEventListener(CHANGE_EVENT, changed);
        window.removeEventListener("storage", storageChanged);
      };
    },
  };
}
