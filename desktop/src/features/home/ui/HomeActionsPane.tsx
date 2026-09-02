import * as React from "react";

import { useAppShell } from "@/app/AppShellContext";
import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import type { HomeRouteSearch } from "@/app/routes/homeSearch";
import { filterActionCenterItems } from "@/features/action-center/actionCenterModel";
import {
  type ActionCenterDataSource,
  useActionCenterContext,
} from "@/features/action-center/ActionCenterContext";
import type {
  ActionCenterFilter,
  ActionItem,
} from "@/features/action-center/contracts";
import {
  actionCenterSourceDestination,
  reminderSourceDestination,
} from "@/features/action-center/lib/actionCenterNavigation";
import { ActionCenterScreen } from "@/features/action-center/ui/ActionCenterScreen";
import { useActionCenterItems } from "@/features/action-center/useActionCenterItems";
import { useIdentityQuery } from "@/shared/api/hooks";
import { useFeatureEnabled } from "@/shared/features";

/**
 * The Actions pane of the Inbox.
 *
 * `ActionCenterProvider` (mounted once in `AppShell`, alongside the sidebar)
 * owns the single `useActionCenterItems` instance. The sidebar badge is
 * always mounted, so reusing its data here rather than mounting a second
 * instance is what keeps the request rate the same whether or not this pane
 * is on screen. See `ActionCenterContext.tsx`. The standalone branch only
 * runs if this pane is ever rendered outside that provider.
 */
export function HomeActionsPane({ search }: { search: HomeRouteSearch }) {
  const shared = useActionCenterContext();
  return shared ? (
    <HomeActionsPaneView actionCenter={shared} search={search} />
  ) : (
    <HomeActionsPaneStandalone search={search} />
  );
}

function HomeActionsPaneStandalone({ search }: { search: HomeRouteSearch }) {
  const { feedItemState } = useAppShell();
  const actionCenter = useActionCenterItems({
    localDoneIds: feedItemState.doneSet,
  });
  return <HomeActionsPaneView actionCenter={actionCenter} search={search} />;
}

function HomeActionsPaneView({
  actionCenter,
  search,
}: {
  actionCenter: ActionCenterDataSource;
  search: HomeRouteSearch;
}) {
  const identityQuery = useIdentityQuery();
  const { goChannel, goHome, goPulse, goWorkflow } = useAppNavigation();
  const pulseEnabled = useFeatureEnabled("pulse");
  const filter = search.filter ?? "needs-action";
  const items = React.useMemo(
    () => filterActionCenterItems(actionCenter.allItems, filter, search.state),
    [actionCenter.allItems, filter, search.state],
  );

  const selectItem = React.useCallback(
    (itemId: string | null) => {
      void goHome({
        action: itemId ?? undefined,
        filter: filter === "needs-action" ? undefined : filter,
        initiative: search.initiative,
        state: search.state,
        view: "actions",
      });
    },
    [filter, goHome, search.initiative, search.state],
  );
  const changeFilter = React.useCallback(
    (nextFilter: ActionCenterFilter) => {
      void goHome({
        action: undefined,
        filter: nextFilter === "needs-action" ? undefined : nextFilter,
        view: "actions",
      });
    },
    [goHome],
  );
  const changeInitiative = React.useCallback(
    (nextInitiative: string | null) => {
      void goHome({
        action: undefined,
        filter: filter === "needs-action" ? undefined : filter,
        initiative: nextInitiative ?? undefined,
        state: search.state,
        view: "actions",
      });
    },
    [filter, goHome, search.state],
  );
  const openPulse = React.useCallback(() => {
    void goPulse();
  }, [goPulse]);
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
      initiative={search.initiative ?? null}
      isLoading={actionCenter.isLoading}
      isSettled={actionCenter.isSettled}
      items={items}
      onDismissPing={actionCenter.dismissPing}
      onFilterChange={changeFilter}
      onInitiativeChange={changeInitiative}
      onOpenPulse={openPulse}
      onOpenSource={openSource}
      onRefresh={actionCenter.refetch}
      onSelectItem={selectItem}
      openCount={actionCenter.openCount}
      pulseEnabled={pulseEnabled}
      selectedItemId={search.action ?? null}
      workflowsEnabled={actionCenter.workflowsEnabled}
    />
  );
}
