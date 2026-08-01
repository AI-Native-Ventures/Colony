import { Building2, Users } from "lucide-react";

import type { Industry } from "../types";
import { resolveDiscoveryAsset } from "../assets";
import { Card } from "@/shared/ui/card";

export type IndustryGridProps = {
  industries: Industry[];
  onSelect: (industry: Industry) => void;
  emptyMessage?: string;
};

export function IndustryGrid({
  industries,
  onSelect,
  emptyMessage = "No industries match this search.",
}: IndustryGridProps) {
  if (industries.length === 0) {
    return (
      <Card className="border-dashed border-border/70 bg-background/30 p-8 text-center shadow-none">
        <Building2 className="mx-auto h-8 w-8 text-muted-foreground" />
        <h2 className="mt-3 text-base font-semibold text-foreground">
          Nothing to show yet
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{emptyMessage}</p>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4.5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {industries.map((industry) => {
        const active = industry.status === "active";
        return (
          <button
            aria-label={`Explore ${industry.name}`}
            className="group overflow-hidden rounded-2xl border border-border bg-card text-left transition-all duration-200 hover:border-border/80 hover:shadow-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`discovery-industry-card-${industry.slug}`}
            key={industry.id}
            onClick={() => onSelect(industry)}
            type="button"
          >
            <div className="relative h-28 items-center justify-center overflow-hidden bg-gradient-to-br from-primary/10 to-background">
              <img
                alt={industry.name}
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                src={resolveDiscoveryAsset(industry.imageKey)}
              />
              <div className="absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-black/20 to-transparent" />
              <div className="absolute right-2.5 top-2.5">
                {active ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-primary-foreground">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />{" "}
                    Active
                  </span>
                ) : (
                  <span className="rounded-full border border-border bg-background px-2.5 py-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Available
                  </span>
                )}
              </div>
            </div>
            <div className="px-4 py-4">
              <div className="mb-2 text-sm font-semibold leading-snug text-foreground">
                {industry.name}
              </div>
              <div className="flex items-center justify-between font-mono text-2xs text-muted-foreground">
                <span>{industry.verticalCount} verticals</span>
                <span className="text-foreground/70">
                  {industry.leadCount > 0
                    ? `${industry.leadCount.toLocaleString("en-US")} leads`
                    : industry.campaignCount > 0
                      ? `${industry.campaignCount} campaigns`
                      : "–"}
                </span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function IndustryAudienceHint() {
  return (
    <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Users aria-hidden="true" className="h-4 w-4" />
      Business discovery is ready. People discovery is coming soon.
    </p>
  );
}
