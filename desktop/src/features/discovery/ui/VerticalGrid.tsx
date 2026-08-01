import { BriefcaseBusiness } from "lucide-react";

import type { Vertical } from "../types";
import { resolveDiscoveryAsset } from "../assets";
import { Card } from "@/shared/ui/card";

export type VerticalGridProps = {
  industryName: string;
  verticals: Vertical[];
  onSelect: (vertical: Vertical) => void;
};

export function VerticalGrid({
  industryName,
  verticals,
  onSelect,
}: VerticalGridProps) {
  if (verticals.length === 0) {
    return (
      <Card className="border-dashed border-border/70 bg-background/30 p-8 text-center shadow-none">
        <BriefcaseBusiness className="mx-auto h-8 w-8 text-muted-foreground" />
        <h2 className="mt-3 text-base font-semibold text-foreground">
          Verticals are on their way
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          We are preparing the first verticals for {industryName}.
        </p>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {verticals.map((vertical) => {
        const active = vertical.status === "active";
        return (
          <button
            aria-label={`Explore ${vertical.name}`}
            className="group overflow-hidden rounded-2xl border border-border bg-background text-left transition-all duration-200 hover:border-border/80 hover:shadow-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`discovery-vertical-card-${vertical.slug}`}
            key={vertical.id}
            onClick={() => onSelect(vertical)}
            type="button"
          >
            <div className="relative aspect-[3/1] items-center justify-center overflow-hidden bg-gradient-to-br from-primary/10 to-background">
              <img
                alt={vertical.name}
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                src={resolveDiscoveryAsset(vertical.imageKey)}
              />
              <div className="absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-black/20 to-transparent" />
              <div className="absolute right-4 top-4">
                {active ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-primary-foreground">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />{" "}
                    Active
                  </span>
                ) : (
                  <span className="rounded-full border border-border bg-background px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Available
                  </span>
                )}
              </div>
            </div>
            <div className="px-5 py-5">
              <div className="mb-3 text-sm font-semibold leading-snug text-foreground">
                {vertical.name}
              </div>
              <div className="flex items-center justify-between font-mono text-2xs text-muted-foreground">
                <span>{vertical.campaignCount} campaigns</span>
                <span className="text-foreground/70">
                  {vertical.leadCount > 0
                    ? `${vertical.leadCount.toLocaleString("en-US")} leads`
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
