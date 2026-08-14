import * as React from "react";
import { RefreshCcw } from "lucide-react";

import { useIsMobile } from "@/shared/hooks/use-mobile";
import { topChromeInset } from "@/shared/layout/chromeLayout";
import { TopChromeInsetHeader } from "@/shared/layout/TopChromeInsetHeader";
import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";

import {
  ACTION_CENTER_FILTERS,
  type ActionCenterFilter,
  type ActionItem,
} from "../contracts";
import { ActionCenterDetail } from "./ActionCenterDetail";
import { ActionCenterList } from "./ActionCenterList";

const FILTER_LABELS: Record<ActionCenterFilter, string> = {
  "needs-action": "Needs action",
  all: "All activity",
  asks: "Asks",
  tasks: "Tasks",
  messages: "Messages",
  reminders: "Reminders",
  workflows: "Workflows",
};

type ActionCenterScreenProps = {
  currentPubkey: string;
  error: Error | null;
  filter: ActionCenterFilter;
  isLoading: boolean;
  items: ActionItem[];
  openCount: number;
  selectedItemId: string | null;
  onFilterChange: (filter: ActionCenterFilter) => void;
  onMarkDone: (item: ActionItem) => void;
  onOpenSource: (item: ActionItem) => Promise<void>;
  onRefresh: () => Promise<void>;
  onSelectItem: (itemId: string | null) => void;
  onUndoDone: (item: ActionItem) => void;
  allItems: ActionItem[];
  workflowsEnabled: boolean;
};

export function ActionCenterScreen({
  allItems,
  currentPubkey,
  error,
  filter,
  isLoading,
  items,
  openCount,
  selectedItemId,
  onFilterChange,
  onMarkDone,
  onOpenSource,
  onRefresh,
  onSelectItem,
  onUndoDone,
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
  const [isRefreshing, setIsRefreshing] = React.useState(false);

  React.useEffect(() => {
    if (selectedItemId && selectedItem === null) {
      onSelectItem(null);
    }
  }, [onSelectItem, selectedItem, selectedItemId]);

  React.useEffect(() => {
    if (visibleFilter !== filter) onFilterChange(visibleFilter);
  }, [filter, onFilterChange, visibleFilter]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  const showList = !isMobile || selectedItem === null;
  const showDetail = !isMobile || selectedItem !== null;

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
            <div className="shrink-0 overflow-x-auto px-3 py-3">
              <Tabs
                onValueChange={(value) => {
                  if (
                    ACTION_CENTER_FILTERS.includes(value as ActionCenterFilter)
                  ) {
                    onFilterChange(value as ActionCenterFilter);
                  }
                }}
                value={visibleFilter}
              >
                <TabsList className="h-auto min-w-max">
                  {availableFilters.map((candidate) => (
                    <TabsTrigger
                      key={candidate}
                      value={candidate}
                      data-testid={`action-center-filter-${candidate}`}
                    >
                      {FILTER_LABELS[candidate]}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
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
                items={items}
                onSelect={onSelectItem}
                selectedId={selectedItemId}
              />
            )}
          </div>
        ) : null}

        {showDetail ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {isMobile && selectedItem ? (
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
                onMarkDone={onMarkDone}
                onOpenSource={(item) => void onOpenSource(item)}
                onUndoDone={onUndoDone}
              />
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
