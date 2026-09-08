import type { FirstJobSession } from "./firstJobSession";

type Entry = { session: FirstJobSession; readers: number };

/** Share only mounted or in-flight presentation sessions for the same root. */
export function createFirstJobSessionCache() {
  const entries = new Map<string, Entry>();
  function evict(key: string, entry: Entry) {
    if (entry.readers !== 0 || entries.get(key) !== entry) return;
    if (entry.session.isBusy()) {
      entry.session.whenIdle(() => evict(key, entry));
      return;
    }
    entries.delete(key);
  }
  return {
    get(key: string, create: () => FirstJobSession): Entry {
      const existing = entries.get(key);
      if (existing) return existing;
      const entry = { session: create(), readers: 0 };
      entries.set(key, entry);
      return entry;
    },
    retain(key: string, entry: Entry) {
      if (!entries.has(key)) entries.set(key, entry);
      entry.readers += 1;
      return () => {
        entry.readers -= 1;
        evict(key, entry);
      };
    },
  };
}
