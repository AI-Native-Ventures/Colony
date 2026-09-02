import * as React from "react";

import { useAppShell } from "@/app/AppShellContext";

import type { ActionItem } from "./contracts";
import { useActionCenterItems } from "./useActionCenterItems";

/**
 * The subset of `useActionCenterItems`'s return value that both the sidebar
 * badge and the Action Center route actually need. `filter`/`state` only
 * affect client-side derivation of `items` from `allItems` (see
 * `filterActionCenterItems`), never the underlying queries, so a single
 * shared instance computed with a fixed option set is sufficient for every
 * consumer — each consumer re-derives its own filtered `items` from
 * `allItems` locally.
 */
export type ActionCenterDataSource = {
  allItems: ActionItem[];
  dismissPing: (pingId: string) => Promise<void>;
  error: Error | null;
  isLoading: boolean;
  isSettled: boolean;
  openCount: number;
  refetch: () => Promise<void>;
  workflowsEnabled: boolean;
};

const ActionCenterContext = React.createContext<ActionCenterDataSource | null>(
  null,
);

/**
 * Mounts the single `useActionCenterItems` instance shared by the sidebar
 * badge and the Inbox's Actions pane.
 *
 * Without this, the badge (always mounted in the sidebar) and the route
 * (mounted only while the screen is open) each ran their own copy of every
 * underlying query, each with its own `refetchInterval` timer. React Query
 * dedupes concurrent fetches for an identical query key, but it does not
 * merge polling intervals across independent observer instances — two
 * mounts of the same query key each keep firing on their own schedule, so
 * opening the screen roughly doubled the request rate. Mounting the hook
 * once here and having every consumer read from context instead removes
 * the second observer entirely.
 */
export function ActionCenterProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { feedItemState } = useAppShell();
  const actionCenter = useActionCenterItems({
    localDoneIds: feedItemState.doneSet,
  });
  const value = React.useMemo<ActionCenterDataSource>(
    () => ({
      allItems: actionCenter.allItems,
      dismissPing: actionCenter.dismissPing,
      error: actionCenter.error,
      isLoading: actionCenter.isLoading,
      isSettled: actionCenter.isSettled,
      openCount: actionCenter.openCount,
      refetch: actionCenter.refetch,
      workflowsEnabled: actionCenter.workflowsEnabled,
    }),
    [
      actionCenter.allItems,
      actionCenter.dismissPing,
      actionCenter.error,
      actionCenter.isLoading,
      actionCenter.isSettled,
      actionCenter.openCount,
      actionCenter.refetch,
      actionCenter.workflowsEnabled,
    ],
  );
  return (
    <ActionCenterContext.Provider value={value}>
      {children}
    </ActionCenterContext.Provider>
  );
}

/** Null when no provider is mounted above the consumer. */
export function useActionCenterContext(): ActionCenterDataSource | null {
  return React.useContext(ActionCenterContext);
}
