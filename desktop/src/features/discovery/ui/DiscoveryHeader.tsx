import { ArrowLeft, Building2, Search, Users } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { cn } from "@/shared/lib/cn";

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

/**
 * This is intentionally shaped like SalesTeams' discovery header. Buzz owns
 * the data and routing, but the visual contract stays in one place: editorial
 * headline, audience switcher, search field, then the contextual catalog.
 */
export function DiscoveryHeader({
  title,
  description,
  breadcrumb,
  onBack,
  mode = "businesses",
  onModeChange,
  query = "",
  onQueryChange,
  showToolbar = false,
  toolbarEntity = "industries",
}: DiscoveryHeaderProps) {
  return (
    <header className="space-y-8">
      <div className="flex items-end justify-between gap-8">
        <div className="min-w-0">
          <h1 className="font-sans text-title font-semibold tracking-tight text-foreground">
            Millions of leads,{" "}
            <em className="not-italic italic text-[#8b5cf6]">
              one search away.
            </em>
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            {mode === "businesses" ? (
              <>
                Explore{" "}
                <span className="font-semibold text-foreground">34</span>{" "}
                industries and{" "}
                <span className="font-semibold text-foreground">500</span>{" "}
                verticals, then launch an AI discovery campaign.
              </>
            ) : (
              <>Explore fields and roles to find individual professionals.</>
            )}
          </p>
        </div>

        {onModeChange ? (
          <fieldset
            aria-label="Discovery audience"
            className="inline-flex shrink-0 items-center gap-1 rounded-2xl border border-border bg-background p-1.5"
            data-testid="discovery-audience-toggle"
          >
            <legend className="sr-only">Discovery audience</legend>
            <button
              className={cn(
                "inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition-colors",
                mode === "businesses"
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => onModeChange("businesses")}
              type="button"
            >
              <Building2 aria-hidden="true" className="h-4 w-4" />
              Businesses
            </button>
            <button
              className={cn(
                "inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold transition-colors",
                mode === "people"
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => onModeChange("people")}
              type="button"
            >
              <Users aria-hidden="true" className="h-4 w-4" />
              People
            </button>
          </fieldset>
        ) : null}
      </div>

      {showToolbar ? (
        <label
          className="flex items-center gap-3 rounded-2xl border border-border bg-background px-6 py-3 shadow-sm focus-within:border-[#8b5cf6] focus-within:ring-4 focus-within:ring-[#8b5cf6]/10"
          htmlFor="discovery-search"
        >
          <Search
            aria-hidden="true"
            className="h-5 w-5 shrink-0 text-muted-foreground"
          />
          <Input
            aria-label={`Search discovery ${toolbarEntity}`}
            className="h-12 flex-1 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
            id="discovery-search"
            onChange={(event) => onQueryChange?.(event.target.value)}
            placeholder={
              mode === "businesses"
                ? "Search industries, verticals, or keywords..."
                : "Search fields, roles, or keywords..."
            }
            value={query}
          />
          <Button
            className="h-12 rounded-xl bg-foreground px-7 text-sm font-semibold text-background hover:bg-foreground/90"
            type="button"
          >
            Search
          </Button>
        </label>
      ) : null}

      {breadcrumb ? (
        <div className="space-y-6 pt-2">
          <button
            className="inline-flex items-center gap-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
            onClick={onBack}
            type="button"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
            Back to {breadcrumb}
          </button>
          <div className="flex items-end justify-between gap-4 border-b border-border pb-6">
            <div>
              <h2 className="font-sans text-3xl font-semibold tracking-tight text-foreground">
                {title}
              </h2>
              {description ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  {description}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </header>
  );
}
