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

function ActionCenterRouteComponent() {
  usePreviewFeatureWarning("actionCenter");
  const search = Route.useSearch();
  const { feedItemState } = useAppShell();
  const identityQuery = useIdentityQuery();
  const { goActionCenter, goChannel, goWorkflow } = useAppNavigation();
  const filter = search.filter ?? "needs-action";
  const actionCenter = useActionCenterItems({
    filter,
    localDoneIds: feedItemState.doneSet,
    state: search.state,
  });

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
  const markDone = React.useCallback(
    (item: ActionItem) => {
      if (item.source.kind === "message") {
        feedItemState.markDone(item.source.item.id);
      }
    },
    [feedItemState],
  );
  const undoDone = React.useCallback(
    (item: ActionItem) => {
      if (item.source.kind === "message") {
        feedItemState.undoDone(item.source.item.id);
      }
    },
    [feedItemState],
  );

  return (
    <ActionCenterScreen
      allItems={actionCenter.allItems}
      currentPubkey={identityQuery.data?.pubkey ?? ""}
      error={actionCenter.error}
      filter={filter}
      isLoading={actionCenter.isLoading}
      isSettled={actionCenter.isSettled}
      items={actionCenter.items}
      onFilterChange={changeFilter}
      onMarkDone={markDone}
      onOpenSource={openSource}
      onRefresh={actionCenter.refetch}
      onSelectItem={selectItem}
      onUndoDone={undoDone}
      openCount={actionCenter.openCount}
      selectedItemId={search.item ?? null}
      workflowsEnabled={actionCenter.workflowsEnabled}
    />
  );
}
