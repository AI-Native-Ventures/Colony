import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useAppShell } from "@/app/AppShellContext";
import {
  ACTION_CENTER_FILTERS,
  ACTION_CENTER_STATES,
  type ActionCenterFilter,
  type ActionCenterStateFilter,
  type ActionItem,
} from "@/features/action-center/contracts";
import {
  actionCenterSourceDestination,
  reminderSourceDestination,
} from "@/features/action-center/lib/actionCenterNavigation";
import { filterActionCenterItems } from "@/features/action-center/actionCenterModel";
import {
  type ActionCenterDataSource,
  useActionCenterContext,
} from "@/features/action-center/ActionCenterContext";
import { ActionCenterScreen } from "@/features/action-center/ui/ActionCenterScreen";
import { useActionCenterItems } from "@/features/action-center/useActionCenterItems";
import { useIdentityQuery } from "@/shared/api/hooks";
import { usePreviewFeatureWarning } from "@/shared/features";

export type ActionCenterRouteSearch = {
  filter?: ActionCenterFilter;
  item?: string;
  state?: ActionCenterStateFilter;
};

function validateActionCenterSearch(
  search: Record<string, unknown>,
): ActionCenterRouteSearch {
  const filter = search.filter;
  const state = search.state;
  return {
    filter:
      typeof filter === "string" &&
      ACTION_CENTER_FILTERS.includes(filter as ActionCenterFilter)
        ? (filter as ActionCenterFilter)
        : undefined,
    item:
      typeof search.item === "string" && search.item.trim() !== ""
        ? search.item
        : undefined,
    state:
      typeof state === "string" &&
      ACTION_CENTER_STATES.includes(state as ActionCenterStateFilter)
        ? (state as ActionCenterStateFilter)
        : undefined,
  };
}

export const Route = createFileRoute("/action-center")({
  validateSearch: validateActionCenterSearch,
  component: ActionCenterRouteComponent,
});

/**
 * `ActionCenterProvider` (mounted once in `AppShell`, alongside the sidebar)
 * owns the single `useActionCenterItems` instance while the flag is on — the
 * sidebar badge is always mounted, so reusing its data here rather than
 * mounting a second instance is what keeps the request rate the same
 * whether or not this screen is open. See `ActionCenterContext.tsx`.
 *
 * When the flag is off the provider does not mount (context is `null`), so
 * this falls back to a standalone instance — matching how every other
 * gated route (pulse, workflows, content) still works for a direct link
 * while merely warning that the feature is a preview.
 */
function ActionCenterRouteComponent() {
  usePreviewFeatureWarning("actionCenter");
  const shared = useActionCenterContext();
  return shared ? (
    <ActionCenterRouteView actionCenter={shared} />
  ) : (
    <ActionCenterRouteStandalone />
  );
}

function ActionCenterRouteStandalone() {
  const { feedItemState } = useAppShell();
  const actionCenter = useActionCenterItems({
    localDoneIds: feedItemState.doneSet,
  });
  return <ActionCenterRouteView actionCenter={actionCenter} />;
}

function ActionCenterRouteView({
  actionCenter,
}: {
  actionCenter: ActionCenterDataSource;
}) {
  const search = Route.useSearch();
  const identityQuery = useIdentityQuery();
  const { goActionCenter, goChannel, goWorkflow } = useAppNavigation();
  const filter = search.filter ?? "needs-action";
  const items = React.useMemo(
    () => filterActionCenterItems(actionCenter.allItems, filter, search.state),
    [actionCenter.allItems, filter, search.state],
  );

  const selectItem = React.useCallback(
    (itemId: string | null) => {
      void goActionCenter({
        filter: filter === "needs-action" ? undefined : filter,
        item: itemId ?? undefined,
        state: search.state,
      });
    },
    [filter, goActionCenter, search.state],
  );
  const changeFilter = React.useCallback(
    (nextFilter: ActionCenterFilter) => {
      void goActionCenter({
        filter: nextFilter === "needs-action" ? undefined : nextFilter,
        item: undefined,
      });
    },
    [goActionCenter],
  );
  const openSource = React.useCallback(
    async (item: ActionItem) => {
      if (item.source.kind === "workflow") {
        await goWorkflow(item.source.workflow.id);
        return;
      }
      const destination = actionCenterSourceDestination(item);
      if (destination) {
        await goChannel(destination.channelId, {
          messageId: destination.messageId,
          threadRootId: destination.threadRootId,
        });
        return;
      }
      const reminderDestination = await reminderSourceDestination(item);
      if (reminderDestination) {
        await goChannel(reminderDestination.channelId, {
          messageId: reminderDestination.messageId,
          threadRootId: reminderDestination.threadRootId,
        });
      }
    },
    [goChannel, goWorkflow],
  );
  return (
    <ActionCenterScreen
      allItems={actionCenter.allItems}
      currentPubkey={identityQuery.data?.pubkey ?? ""}
      error={actionCenter.error}
      filter={filter}
      isLoading={actionCenter.isLoading}
      isSettled={actionCenter.isSettled}
      items={items}
      onDismissPing={actionCenter.dismissPing}
      onFilterChange={changeFilter}
      onOpenSource={openSource}
      onRefresh={actionCenter.refetch}
      onSelectItem={selectItem}
      openCount={actionCenter.openCount}
      selectedItemId={search.item ?? null}
      workflowsEnabled={actionCenter.workflowsEnabled}
    />
  );
}
