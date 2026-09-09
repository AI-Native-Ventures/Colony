// Shared by the inert WebKit export page, Chromium import page, and CI tests.
export const MIGRATION_MARKER = "colony.electron.webview-migration.v1";
const CACHE_PREFIXES = [
  "buzz-channel-messages.v1:",
  "buzz-channels.v1:",
  "buzz-observed-unread.v1:",
  "buzz-sidebar-skeleton-shape.v1:",
  "buzz-timeline-skeleton-shape.v1:",
  "buzz-user-labels.v1:",
];

/** Copy this application's durable state, excluding disposable relay snapshots. */
export function migrationKey(key) {
  return (
    typeof key === "string" &&
    /^(buzz[-.:]|colony[-.:]|sprout-)/.test(key) &&
    key !== MIGRATION_MARKER &&
    !CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

export function validateEntries(entries) {
  if (
    !Array.isArray(entries) ||
    entries.length > 10000 ||
    entries.some(
      (entry) =>
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        !migrationKey(entry[0]) ||
        typeof entry[1] !== "string",
    )
  )
    throw new Error("Colony could not validate the saved app state.");
  if (
    new TextEncoder().encode(JSON.stringify(entries)).byteLength >
    8 * 1024 * 1024
  )
    throw new Error("The saved app state is too large to transfer safely.");
  if (new Set(entries.map(([key]) => key)).size !== entries.length)
    throw new Error("The saved app state contains duplicate entries.");
  return entries;
}

/** Reads only the current WebView origin. It never scans other website databases. */
export function collectLegacyState(storage) {
  const entries = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!migrationKey(key)) continue;
    const value = storage.getItem(key);
    if (value !== null) entries.push([key, value]);
  }
  return validateEntries(entries);
}

/** Complete once, after verified writes; retries never overwrite newer Electron state. */
export function importLegacyState(storage, entries) {
  if (storage.getItem(MIGRATION_MARKER) === "complete") return 0;
  validateEntries(entries);
  const inserted = [];
  try {
    for (const [key, value] of entries) {
      if (storage.getItem(key) !== null) continue;
      storage.setItem(key, value);
      inserted.push(key);
      if (storage.getItem(key) !== value)
        throw new Error("Saved app state was not retained.");
    }
    storage.setItem(MIGRATION_MARKER, "complete");
    if (storage.getItem(MIGRATION_MARKER) !== "complete")
      throw new Error("Migration was not retained.");
    return inserted.length;
  } catch {
    // The source is untouched. A failed write cannot mark an incomplete import done.
    for (const key of [MIGRATION_MARKER, ...inserted]) {
      try {
        storage.removeItem(key);
      } catch {
        /* Retry will preserve any retained partial state. */
      }
    }
    throw new Error(
      "Colony could not restore the saved app state. Free some storage and reopen Colony to retry.",
    );
  }
}
