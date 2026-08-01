import { BriefcaseBusiness } from "lucide-react";

import { Card } from "@/shared/ui/card";
import { resolveDiscoveryAsset } from "../assets";
import type { ProfessionalField } from "../types";

export type FieldGridProps = {
  fields: ProfessionalField[];
  onSelect: (field: ProfessionalField) => void;
};

export function FieldGrid({ fields, onSelect }: FieldGridProps) {
  if (fields.length === 0) {
    return (
      <Card className="border-dashed border-border/70 bg-background/30 p-8 text-center shadow-none">
        <BriefcaseBusiness className="mx-auto h-8 w-8 text-muted-foreground" />
        <h2 className="mt-3 text-base font-semibold text-foreground">
          No fields match this search
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Adjust the search or filters to explore professional fields.
        </p>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4.5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {fields.map((field) => {
        const active = field.status === "active";
        return (
          <button
            aria-label={`Explore ${field.name}`}
            className="group overflow-hidden rounded-2xl border border-border bg-card text-left transition-all duration-200 hover:border-border/80 hover:shadow-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`discovery-field-card-${field.slug}`}
            key={field.id}
            onClick={() => onSelect(field)}
            type="button"
          >
            <div className="relative h-28 overflow-hidden bg-gradient-to-br from-primary/10 to-background">
              <img
                alt={field.name}
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                src={resolveDiscoveryAsset(field.imageKey)}
              />
              <div className="absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-black/20 to-transparent" />
              <div className="absolute right-2.5 top-2.5">
                {active ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-primary-foreground">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
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
                {field.displayName ?? field.name}
              </div>
              <div className="flex items-center justify-between font-mono text-2xs text-muted-foreground">
                <span>{field.roleCount} roles</span>
                <span className="text-foreground/70">
                  {field.leadCount > 0
                    ? `${field.leadCount.toLocaleString("en-US")} people`
                    : field.campaignCount > 0
                      ? `${field.campaignCount} campaigns`
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
