import { ArrowUpRight, Building2, Users } from "lucide-react";

import type { Industry } from "../types";
import { resolveDiscoveryAsset } from "../assets";
import { Badge } from "@/shared/ui/badge";
import { Card } from "@/shared/ui/card";
import { MetricCard } from "./MetricCard";

export type IndustryGridProps = {
  industries: Industry[];
  onSelect: (industry: Industry) => void;
  emptyMessage?: string;
};

function statusVariant(status: Industry["status"]) {
  return status === "active" ? "success" : "secondary";
}

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
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {industries.map((industry) => (
        <Card
          className="group overflow-hidden border-border/60 bg-card/80 p-0 shadow-none transition-colors hover:border-primary/40 hover:bg-card"
          key={industry.id}
        >
          <button
            aria-label={`Explore ${industry.name}`}
            className="flex h-full w-full flex-col text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            data-testid={`discovery-industry-card-${industry.slug}`}
            onClick={() => onSelect(industry)}
            type="button"
          >
            <div className="relative h-36 overflow-hidden bg-muted/30">
              <img
                alt={industry.name}
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                src={resolveDiscoveryAsset(industry.imageKey)}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/5 to-transparent" />
              <Badge
                className="absolute left-3 top-3"
                variant={statusVariant(industry.status)}
              >
                {industry.status}
              </Badge>
              <span className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2 text-white">
                <span className="text-lg font-semibold">{industry.name}</span>
                <ArrowUpRight aria-hidden="true" className="h-5 w-5" />
              </span>
            </div>
            <div className="flex flex-1 flex-col gap-4 p-4">
              <p className="line-clamp-2 min-h-10 text-sm text-muted-foreground">
                {industry.description ?? "Explore this market with Colony."}
              </p>
              <div className="mt-auto grid grid-cols-3 gap-2">
                <MetricCard label="Verticals" value={industry.verticalCount} />
                <MetricCard label="Campaigns" value={industry.campaignCount} />
                <MetricCard
                  hint="Across campaigns"
                  label="Leads"
                  value={industry.leadCount}
                />
              </div>
            </div>
          </button>
        </Card>
      ))}
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
