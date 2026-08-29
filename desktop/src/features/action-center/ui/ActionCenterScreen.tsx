import * as React from "react";
import { RefreshCcw } from "lucide-react";

import { useIsMobile } from "@/shared/hooks/use-mobile";
import { topChromeInset } from "@/shared/layout/chromeLayout";
import { TopChromeInsetHeader } from "@/shared/layout/TopChromeInsetHeader";
import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";

import {
  ACTION_CENTER_FILTERS,
  type ActionCenterFilter,
  type ActionItem,
} from "../contracts";
import {
  filterByInitiative,
  selectInitiativeChips,
} from "../lib/initiativeChips";
import { ActionCenterDetail } from "./ActionCenterDetail";
import { ActionCenterFilterMenu } from "./ActionCenterFilterMenu";
import { ActionCenterInitiativeChips } from "./ActionCenterInitiativeChips";
import { ActionCenterList } from "./ActionCenterList";

type ActionCenterScreenProps = {
  currentPubkey: string;
  error: Error | null;
  filter: ActionCenterFilter;
  initiative: string | null;
  isLoading: boolean;
  isSettled: boolean;
  items: ActionItem[];
  openCount: number;
  selectedItemId: string | null;
  onDismissPing: (pingId: string) => Promise<void>;
  onFilterChange: (filter: ActionCenterFilter) => void;
  onInitiativeChange: (initiative: string | null) => void;
  onOpenSource: (item: ActionItem) => Promise<void>;
  onRefresh: () => Promise<void>;
  onSelectItem: (itemId: string | null) => void;
  allItems: ActionItem[];
  workflowsEnabled: boolean;
};

export function ActionCenterScreen({
  allItems,
  currentPubkey,
  error,
  filter,
  initiative,
  isLoading,
  isSettled,
  items,
  openCount,
  selectedItemId,
  onDismissPing,
  onFilterChange,
  onInitiativeChange,
  onOpenSource,
  onRefresh,
  onSelectItem,
  workflowsEnabled,
}: ActionCenterScreenProps) {
  const isMobile = useIsMobile();
  const availableFilters = React.useMemo(
    () =>
      ACTION_CENTER_FILTERS.filter(
        (candidate) => candidate !== "workflows" || workflowsEnabled,
      ),
    [workflowsEnabled],
  );
  const visibleFilter = availableFilters.includes(filter)
    ? filter
    : "needs-action";
  const selectedItem = React.useMemo(
    () => allItems.find((item) => item.id === selectedItemId) ?? null,
    [allItems, selectedItemId],
  );
  // Chips derive from the kind/state-filtered `items`, not from the
  // initiative-filtered result -- otherwise picking one chip would hide the
  // others (spec: chips filter, they never regroup, and the badge/chip set
  // stays whole-view while only what's rendered narrows).
  const initiativeChips = React.useMemo(
    () => selectInitiativeChips(items),
    [items],
  );
  const visibleItems = React.useMemo(
    () => filterByInitiative(items, initiative),
    [items, initiative],
  );
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [refreshRequestedFor, setRefreshRequestedFor] = React.useState<
    string | null
  >(null);

  // Optimistic "resolving" marks for asks answered by an in-thread reply
  // (spec: "Optimistically mark the item resolving; reconcile from the
  // open-asks refetch"). Keyed by ask id, but a single thread reply can
  // close every open ask bound to that thread root
  // (`try_auto_resolve_from_reply` resolves all of them, not just one), so
  // marking happens by thread id across every open ask sharing it, not by
  // the one ask the composer was open on.
  const [resolvingAskIds, setResolvingAskIds] = React.useState<
    ReadonlySet<string>
  >(new Set());
  const markThreadResolving = React.useCallback(
    (threadId: string) => {
      setResolvingAskIds((previous) => {
        const next = new Set(previous);
        for (const candidate of allItems) {
          if (
            candidate.source.kind === "ask" &&
            !candidate.source.resolution &&
            candidate.source.ask.threadId === threadId
          ) {
            next.add(candidate.source.ask.id);
          }
        }
        return next;
      });
    },
    [allItems],
  );
  // Reconcile from the open-asks refetch: once an ask no longer appears as
  // an open ask row at all (the relay's auto-resolve landed and
  // `selectOpenAsks` excluded it), its optimistic mark is stale and must
  // drop, whether or not the refetch was the one that closed it.
  React.useEffect(() => {
    setResolvingAskIds((previous) => {
      if (previous.size === 0) return previous;
      const stillOpenAskIds = new Set(
        allItems.flatMap((item) =>
          item.source.kind === "ask" && !item.source.resolution
            ? [item.source.ask.id]
            : [],
        ),
      );
      const next = new Set(
        [...previous].filter((askId) => stillOpenAskIds.has(askId)),
      );
      return next.size === previous.size ? previous : next;
    });
  }, [allItems]);

  React.useEffect(() => {
    if (refreshRequestedFor && refreshRequestedFor !== selectedItemId) {
      setRefreshRequestedFor(null);
    }
  }, [refreshRequestedFor, selectedItemId]);

  React.useEffect(() => {
    if (!isSettled || error || !selectedItemId) return;
    // No "filter === all" shortcut here: an initiative chip can hide a
    // selected item even under the "all" kind filter, so visibility must
    // always be checked against what is actually rendered.
    const isVisibleInFilter = visibleItems.some(
      (item) => item.id === selectedItemId,
    );
    const wasRefreshed = refreshRequestedFor === selectedItemId;
    if (
      (selectedItem === null && wasRefreshed) ||
      (selectedItem && !isVisibleInFilter)
    ) {
      onSelectItem(null);
      if (wasRefreshed) setRefreshRequestedFor(null);
    }
  }, [
    error,
    isSettled,
    onSelectItem,
    refreshRequestedFor,
    selectedItem,
    selectedItemId,
    visibleItems,
  ]);

  React.useEffect(() => {
    if (visibleFilter !== filter) onFilterChange(visibleFilter);
  }, [filter, onFilterChange, visibleFilter]);

  const handleRefresh = async () => {
    if (selectedItemId) setRefreshRequestedFor(selectedItemId);
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  const unavailableItemId =
    isSettled && selectedItemId && selectedItem === null
      ? selectedItemId
      : null;
  const hasDetail = selectedItem !== null || unavailableItemId !== null;
  const showList = !isMobile || !hasDetail;
  const showDetail = !isMobile || hasDetail;

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background/60"
      data-testid="action-center-screen"
    >
      <TopChromeInsetHeader flush transparent>
        <div className="flex min-h-12 items-center gap-3 border-b border-border/45 px-5 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-semibold text-foreground">
                Action Center
              </h1>
              {openCount > 0 ? (
                <Badge data-testid="action-center-open-count" variant="warning">
                  {Math.min(openCount, 99)}
                </Badge>
              ) : null}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              One place to answer, unblock, and open the work that matters.
            </p>
          </div>
          <Button
            aria-label="Refresh Action Center"
            className="size-8 shrink-0"
            data-testid="action-center-refresh"
            disabled={isRefreshing}
            onClick={() => void handleRefresh()}
            size="icon"
            variant="ghost"
          >
            <RefreshCcw
              className={cn("size-4", isRefreshing && "animate-spin")}
            />
          </Button>
        </div>
      </TopChromeInsetHeader>

      {error ? (
        <div
          className="border-b border-destructive/25 bg-destructive/5 px-5 py-2 text-sm text-destructive"
          data-testid="action-center-source-error"
        >
          Some Action Center sources could not be refreshed: {error.message}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {showList ? (
          <div
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col border-r border-border/45 md:flex-none md:w-[24rem]",
              topChromeInset.divider,
            )}
            data-testid="action-center-list-pane"
          >
            <div className="shrink-0 px-3 py-3">
              <ActionCenterFilterMenu
                availableFilters={availableFilters}
                filter={visibleFilter}
                onFilterChange={onFilterChange}
              />
            </div>
            <ActionCenterInitiativeChips
              chips={initiativeChips}
              initiative={initiative}
              onInitiativeChange={onInitiativeChange}
            />
            {isLoading ? (
              <div
                className="space-y-3 px-4 py-5"
                data-testid="action-center-loading"
              >
                <div className="h-16 animate-pulse rounded-xl bg-muted/60" />
                <div className="h-16 animate-pulse rounded-xl bg-muted/60" />
                <div className="h-16 animate-pulse rounded-xl bg-muted/60" />
              </div>
            ) : (
              <ActionCenterList
                items={visibleItems}
                onSelect={onSelectItem}
                resolvingAskIds={resolvingAskIds}
                selectedId={selectedItemId}
              />
            )}
          </div>
        ) : null}

        {showDetail ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {isMobile && hasDetail ? (
              <div className="shrink-0 border-b border-border/45 px-4 py-2">
                <Button
                  onClick={() => onSelectItem(null)}
                  size="sm"
                  variant="ghost"
                >
                  Back to actions
                </Button>
              </div>
            ) : null}
            {isLoading && selectedItem === null ? (
              <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                Loading Action Center…
              </div>
            ) : (
              <ActionCenterDetail
                currentPubkey={currentPubkey}
                item={selectedItem}
                onBack={() => onSelectItem(null)}
                onDismissPing={onDismissPing}
                onOpenSource={(item) => void onOpenSource(item)}
                onRefresh={handleRefresh}
                onThreadReplySent={markThreadResolving}
                resolvingAskIds={resolvingAskIds}
                unavailableItemId={unavailableItemId}
              />
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
