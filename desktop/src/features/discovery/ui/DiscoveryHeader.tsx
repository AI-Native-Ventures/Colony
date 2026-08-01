import {
  ArrowLeft,
  LockKeyhole,
  Search,
  SlidersHorizontal,
} from "lucide-react";

import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";

export type DiscoveryMode = "businesses" | "people";
export type DiscoveryStatusFilter = "all" | "active" | "available";

export type DiscoveryHeaderProps = {
  title: string;
  description?: string;
  breadcrumb?: string;
  onBack?: () => void;
  mode?: DiscoveryMode;
  onModeChange?: (mode: DiscoveryMode) => void;
  query?: string;
  onQueryChange?: (query: string) => void;
  statusFilter?: DiscoveryStatusFilter;
  onStatusFilterChange?: (status: DiscoveryStatusFilter) => void;
  showToolbar?: boolean;
  toolbarEntity?: string;
};

export function DiscoveryHeader({
  title,
  description,
  breadcrumb,
  onBack,
  mode = "businesses",
  onModeChange,
  query = "",
  onQueryChange,
  statusFilter = "all",
  onStatusFilterChange,
  showToolbar = false,
  toolbarEntity = "industries",
}: DiscoveryHeaderProps) {
  return (
    <header className="space-y-4 border-b border-border/50 pb-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          {onBack ? (
            <Button
              aria-label={breadcrumb ? `Back to ${breadcrumb}` : "Go back"}
              className="mt-0.5 shrink-0"
              onClick={onBack}
              size="icon"
              variant="ghost"
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
          ) : null}
          <div className="min-w-0">
            {breadcrumb ? (
              <p className="text-2xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                {breadcrumb}
              </p>
            ) : null}
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
              {title}
            </h1>
            {description ? (
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
        </div>

        {onModeChange ? (
          <Tabs
            aria-label="Discovery audience"
            onValueChange={(value) => {
              if (value === "businesses" || value === "people") {
                onModeChange(value);
              }
            }}
            value={mode}
          >
            <TabsList>
              <TabsTrigger value="businesses">Businesses</TabsTrigger>
              <TabsTrigger value="people">
                <LockKeyhole aria-hidden="true" className="mr-1 h-3 w-3" />
                People
                <Badge className="ml-1" variant="secondary">
                  Soon
                </Badge>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}
      </div>

      {showToolbar ? (
        <div className="flex flex-wrap items-center gap-2">
          <label
            className="relative min-w-56 flex-1 sm:max-w-md"
            htmlFor="discovery-search"
          >
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label={`Search discovery ${toolbarEntity}`}
              className="pl-9"
              id="discovery-search"
              onChange={(event) => onQueryChange?.(event.target.value)}
              placeholder={`Search ${toolbarEntity}`}
              value={query}
            />
          </label>
          <label className="flex h-9 items-center gap-2 rounded-lg border border-input/40 bg-background px-3 text-sm text-muted-foreground">
            <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
            <span className="sr-only">Filter {toolbarEntity}</span>
            <select
              aria-label={`Filter ${toolbarEntity}`}
              className="bg-transparent text-sm text-foreground outline-hidden"
              onChange={(event) =>
                onStatusFilterChange?.(
                  event.target.value as DiscoveryStatusFilter,
                )
              }
              value={statusFilter}
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="available">Available</option>
            </select>
          </label>
        </div>
      ) : null}
    </header>
  );
}
