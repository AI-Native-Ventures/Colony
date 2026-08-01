import { ArrowUpRight, BriefcaseBusiness } from "lucide-react";

import type { Vertical } from "../types";
import { resolveDiscoveryAsset } from "../assets";
import { Badge } from "@/shared/ui/badge";
import { Card } from "@/shared/ui/card";
import { MetricCard } from "./MetricCard";

export type VerticalGridProps = {
  industryName: string;
  verticals: Vertical[];
  onSelect: (vertical: Vertical) => void;
};

function statusVariant(status: Vertical["status"]) {
  return status === "active" ? "success" : "secondary";
}

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
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {verticals.map((vertical) => (
        <Card
          className="group overflow-hidden border-border/60 bg-card/80 p-0 shadow-none transition-colors hover:border-primary/40 hover:bg-card"
          key={vertical.id}
        >
          <button
            aria-label={`Explore ${vertical.name}`}
            className="flex h-full w-full flex-col text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            data-testid={`discovery-vertical-card-${vertical.slug}`}
            onClick={() => onSelect(vertical)}
            type="button"
          >
            <div className="relative h-40 overflow-hidden bg-muted/30">
              <img
                alt={vertical.name}
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                src={resolveDiscoveryAsset(vertical.imageKey)}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/5 to-transparent" />
              <Badge
                className="absolute left-3 top-3"
                variant={statusVariant(vertical.status)}
              >
                {vertical.status}
              </Badge>
              <span className="absolute bottom-3 left-3 right-3 flex items-center justify-between gap-2 text-white">
                <span className="text-lg font-semibold">{vertical.name}</span>
                <ArrowUpRight aria-hidden="true" className="h-5 w-5" />
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 p-4">
              <MetricCard label="Campaigns" value={vertical.campaignCount} />
              <MetricCard label="Leads" value={vertical.leadCount} />
            </div>
          </button>
        </Card>
      ))}
    </div>
  );
}
