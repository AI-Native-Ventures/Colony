import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createFirstJobRuntime } from "./firstJobRuntime";
import { createFirstJobSession } from "./firstJobSession";
import { createFirstJobSessionCache } from "./firstJobSessionCache";
import { firstJobScopeKey, type FirstJobScope } from "./firstJobStart";

const sessions = createFirstJobSessionCache();

/** One local presentation session for the same root in channel and thread panes. */
export function useFirstJobSuggestion(
  scope: FirstJobScope,
  initialBrief: string,
) {
  const key = firstJobScopeKey(scope);
  const entry = useMemo(
    () =>
      sessions.get(key, () =>
        createFirstJobSession(createFirstJobRuntime(scope), initialBrief),
      ),
    [key, scope, initialBrief],
  );
  useEffect(() => sessions.retain(key, entry), [entry, key]);
  const snapshot = useSyncExternalStore(
    entry.session.subscribe,
    entry.session.getSnapshot,
    entry.session.getSnapshot,
  );
  return { session: entry.session, snapshot };
}
