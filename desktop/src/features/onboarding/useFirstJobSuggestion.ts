import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createFirstJobRuntime } from "./firstJobRuntime";
import { createFirstJobSession } from "./firstJobSession";
import { createFirstJobSessionCache } from "./firstJobSessionCache";
import { firstJobScopeKey, type FirstJobScope } from "./firstJobStart";
import type { FirstJobSuggestion } from "./firstJobSuggestion";

const sessions = createFirstJobSessionCache();

/** One local presentation session for the same root in channel and thread panes. */
export function useFirstJobSuggestion(
  scope: FirstJobScope,
  payload: FirstJobSuggestion,
) {
  const key = firstJobScopeKey(scope);
  const entry = useMemo(
    () =>
      sessions.get(key, () =>
        createFirstJobSession(
          createFirstJobRuntime(scope, payload),
          payload.brief,
        ),
      ),
    [key, scope, payload],
  );
  useEffect(() => sessions.retain(key, entry), [entry, key]);
  const snapshot = useSyncExternalStore(
    entry.session.subscribe,
    entry.session.getSnapshot,
    entry.session.getSnapshot,
  );
  return { session: entry.session, snapshot };
}
