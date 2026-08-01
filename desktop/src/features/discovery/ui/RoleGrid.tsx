import { UsersRound } from "lucide-react";

import { Card } from "@/shared/ui/card";
import { resolveDiscoveryAsset } from "../assets";
import type { ProfessionalRole } from "../types";

export type RoleGridProps = {
  fieldName: string;
  roles: ProfessionalRole[];
  onSelect: (role: ProfessionalRole) => void;
};

export function RoleGrid({ fieldName, roles, onSelect }: RoleGridProps) {
  if (roles.length === 0) {
    return (
      <Card className="border-dashed border-border/70 bg-background/30 p-8 text-center shadow-none">
        <UsersRound className="mx-auto h-8 w-8 text-muted-foreground" />
        <h2 className="mt-3 text-base font-semibold text-foreground">
          No roles match this search
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Adjust the search to explore roles within {fieldName}.
        </p>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4.5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {roles.map((role) => {
        const active = role.status === "active";
        return (
          <button
            aria-label={`Explore ${role.name}`}
            className="group overflow-hidden rounded-2xl border border-border bg-card text-left transition-all duration-200 hover:border-border/80 hover:shadow-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            data-testid={`discovery-role-card-${role.slug}`}
            key={role.id}
            onClick={() => onSelect(role)}
            type="button"
          >
            <div className="relative h-28 overflow-hidden bg-gradient-to-br from-primary/10 to-background">
              <img
                alt={fieldName}
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                src={resolveDiscoveryAsset(role.imageKey)}
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
                {role.name}
              </div>
              <div className="flex items-center justify-between font-mono text-2xs text-muted-foreground">
                <span>{role.campaignCount} campaigns</span>
                <span className="text-foreground/70">
                  {role.leadCount > 0
                    ? `${role.leadCount.toLocaleString("en-US")} people`
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
