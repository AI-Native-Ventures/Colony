import { LayoutGrid, List } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/lib/cn";

type DiscoveryListFiltersProps = {
  selectedFilter: string;
  onFilterChange: (filter: string) => void;
  viewMode: "grid" | "list";
  onViewModeChange: (mode: "grid" | "list") => void;
  total: number;
  showFilters?: boolean;
  entity?: "Industries" | "Fields";
};

export function DiscoveryListFilters({
  selectedFilter,
  onFilterChange,
  viewMode,
  onViewModeChange,
  total,
  showFilters = true,
  entity = "Industries",
}: DiscoveryListFiltersProps) {
  const filters = [
    `All ${entity}`,
    "Active",
    "Has Campaigns",
    "New Opportunities",
  ];
  return (
    <div className="flex flex-wrap items-center justify-between gap-5">
      {showFilters ? (
        <div className="flex flex-wrap items-center gap-3">
          {filters.map((filter) => (
            <button
              className={cn(
                "rounded-full border px-5 py-2.5 text-sm font-semibold transition-colors",
                selectedFilter === filter
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-background text-muted-foreground hover:text-foreground",
              )}
              key={filter}
              onClick={() => onFilterChange(filter)}
              type="button"
            >
              {filter}
            </button>
          ))}
        </div>
      ) : (
        <span className="font-mono text-xs text-muted-foreground">
          {total} available
        </span>
      )}
      <div className="flex items-center gap-3">
        {showFilters ? (
          <span className="font-mono text-xs text-muted-foreground">
            {total} available
          </span>
        ) : null}
        <div className="flex items-center rounded-lg border border-border bg-background p-1">
          <Button
            aria-label="Grid view"
            className={cn(
              "h-7 w-7 rounded-md",
              viewMode === "grid"
                ? "bg-muted text-foreground"
                : "text-muted-foreground",
            )}
            onClick={() => onViewModeChange("grid")}
            size="icon"
            type="button"
            variant="ghost"
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            aria-label="List view"
            className={cn(
              "h-7 w-7 rounded-md",
              viewMode === "list"
                ? "bg-muted text-foreground"
                : "text-muted-foreground",
            )}
            onClick={() => onViewModeChange("list")}
            size="icon"
            type="button"
            variant="ghost"
          >
            <List className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
