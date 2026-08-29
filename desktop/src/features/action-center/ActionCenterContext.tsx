import * as React from "react";

import { useAppShell } from "@/app/AppShellContext";
import { FeatureGate } from "@/shared/features";

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
 * badge and the Action Center route while `actionCenter` is enabled.
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
function ActionCenterDataMount({ children }: { children: React.ReactNode }) {
  const { feedItemState } = useAppShell();
  const actionCenter = useActionCenterItems({
    localDoneIds: feedItemState.doneSet,
  });
  const value = React.useMemo<ActionCenterDataSource>(
    () => ({
      allItems: actionCenter.allItems,
      error: actionCenter.error,
      isLoading: actionCenter.isLoading,
      isSettled: actionCenter.isSettled,
      openCount: actionCenter.openCount,
      refetch: actionCenter.refetch,
      workflowsEnabled: actionCenter.workflowsEnabled,
    }),
    [
      actionCenter.allItems,
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

/**
 * Wrap the part of the tree that contains both the sidebar and the routed
 * screens with this once (in `AppShell`). While the feature is disabled it
 * renders `children` unchanged — no hook mount, no queries — and consumers
 * fall back to `null`, which the route component uses as its signal to
 * mount a standalone (single) instance for direct-link access matching the
 * rest of the preview-feature routes (pulse, workflows, content).
 */
export function ActionCenterProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <FeatureGate feature="actionCenter" fallback={children}>
      <ActionCenterDataMount>{children}</ActionCenterDataMount>
    </FeatureGate>
  );
}

/** Null when `actionCenter` is disabled (the provider did not mount). */
export function useActionCenterContext(): ActionCenterDataSource | null {
  return React.useContext(ActionCenterContext);
}
