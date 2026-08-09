import * as React from "react";
import { ExternalLink, Link2, Mail } from "lucide-react";

import { Badge } from "@/shared/ui/badge";
import { Card } from "@/shared/ui/card";
import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import type { DiscoverySearch } from "@/app/routes/discovery";
import type { Lead } from "../types";
import { stableLeadOrder } from "./LeadFilters";
import type { LeadTableView } from "./LeadTable";

type PeopleLeadTableProps = {
  leads: readonly Lead[];
  scope: "campaign" | "global";
  search: DiscoverySearch;
  view: LeadTableView;
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function statusVariant(status: Lead["status"]) {
  if (status === "qualified" || status === "client_active")
    return "success" as const;
  if (status === "accepted") return "info" as const;
  if (status === "dormant") return "warning" as const;
  if (status === "disqualified") return "destructive" as const;
  return "secondary" as const;
}

function PersonIdentity({ lead }: { lead: Lead }) {
  const name = lead.personName ?? lead.contactName ?? lead.companyName;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-primary/10 text-xs font-semibold text-primary">
        {lead.avatarUrl ? (
          <img
            alt=""
            className="h-full w-full object-cover"
            src={lead.avatarUrl}
          />
        ) : (
          initials(name)
        )}
      </div>
      <div className="min-w-0">
        <p className="truncate font-semibold text-foreground">{name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {lead.headline ?? lead.roleName ?? lead.contactTitle}
        </p>
      </div>
    </div>
  );
}

function PeopleGrid({
  leads,
  onOpenLead,
}: {
  leads: readonly Lead[];
  onOpenLead: (leadId: string) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {stableLeadOrder(leads).map((lead) => (
        <Card
          className="cursor-pointer border-border/60 bg-card/70 p-5 shadow-none transition-colors hover:bg-card"
          data-testid={`person-card-${lead.id}`}
          key={lead.id}
          onClick={() => onOpenLead(lead.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onOpenLead(lead.id);
            }
          }}
          role="button"
          tabIndex={0}
        >
          <div className="flex items-start justify-between gap-3">
            <PersonIdentity lead={lead} />
            <Badge variant={statusVariant(lead.status)}>{lead.status}</Badge>
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-3 text-xs">
            <div>
              <dt className="text-muted-foreground">Company</dt>
              <dd className="mt-1 font-medium text-foreground">
                {lead.currentCompany ?? lead.companyName}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Location</dt>
              <dd className="mt-1 font-medium text-foreground">
                {lead.location}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Seniority</dt>
              <dd className="mt-1 font-medium text-foreground">
                {lead.seniority ?? "—"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Score</dt>
              <dd className="mt-1 font-medium text-foreground">{lead.score}</dd>
            </div>
          </dl>
          <div className="mt-4 flex flex-wrap gap-3 text-xs text-muted-foreground">
            {lead.email ? (
              <span className="inline-flex items-center gap-1">
                <Mail className="h-3.5 w-3.5" />
                {lead.email}
              </span>
            ) : null}
            {lead.linkedinUrl ? (
              <a
                className="inline-flex items-center gap-1 text-primary hover:underline"
                href={lead.linkedinUrl}
                onClick={(event) => event.stopPropagation()}
                rel="noreferrer"
                target="_blank"
              >
                <Link2 className="h-3.5 w-3.5" />
                LinkedIn
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : null}
          </div>
        </Card>
      ))}
    </div>
  );
}

export function PeopleLeadTable({
  leads,
  scope,
  search,
  view,
}: PeopleLeadTableProps) {
  const { goDiscovery } = useAppNavigation();
  const openLead = React.useCallback(
    (leadId: string) => {
      void goDiscovery({ ...search, leadId });
    },
    [goDiscovery, search],
  );
  const rows = stableLeadOrder(leads);
  if (rows.length === 0) {
    return (
      <Card className="border-dashed border-border/70 bg-background/30 p-8 text-center shadow-none">
        <h2 className="text-base font-semibold">
          No people match these filters
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Clear a filter or adjust the search to see matching professionals.
        </p>
      </Card>
    );
  }
  if (view === "grid") return <PeopleGrid leads={rows} onOpenLead={openLead} />;
  return (
    <Card className="overflow-hidden border-border/60 bg-card/70 p-0 shadow-none">
      <div className="overflow-x-auto">
        <table
          className="w-full min-w-[62rem] text-sm"
          data-testid={`${scope}-people-table`}
        >
          <caption className="sr-only">Discovered people</caption>
          <thead className="bg-muted/25 text-left text-2xs uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
              <th className="w-10 px-4 py-3">
                <input aria-label="Select all people" type="checkbox" />
              </th>
              <th className="px-4 py-3 font-medium">Person</th>
              <th className="px-4 py-3 font-medium">Company</th>
              <th className="px-4 py-3 font-medium">Location</th>
              <th className="px-4 py-3 font-medium">Seniority</th>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Score</th>
              <th className="px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((lead) => {
              const name =
                lead.personName ?? lead.contactName ?? lead.companyName;
              return (
                <tr
                  className="cursor-pointer border-t border-border/50 transition-colors hover:bg-muted/30"
                  data-testid={`person-row-${lead.id}`}
                  key={lead.id}
                  onClick={() => openLead(lead.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openLead(lead.id);
                    }
                  }}
                  tabIndex={0}
                >
                  <td className="px-4 py-3">
                    <input
                      aria-label={`Select ${name}`}
                      onClick={(event) => event.stopPropagation()}
                      type="checkbox"
                    />
                  </td>
                  <th className="px-4 py-3 text-left font-normal">
                    <PersonIdentity lead={lead} />
                  </th>
                  <td className="px-4 py-3 text-muted-foreground">
                    {lead.currentCompany ?? lead.companyName}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {lead.location}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {lead.seniority ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {lead.email ?? "—"}
                  </td>
                  <td className="px-4 py-3 font-semibold tabular-nums">
                    {lead.score}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={statusVariant(lead.status)}>
                      {lead.status}
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
