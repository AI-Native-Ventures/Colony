import * as React from "react";
import { ExternalLink, Globe2, Mail, Phone } from "lucide-react";

import { Badge } from "@/shared/ui/badge";
import { Card } from "@/shared/ui/card";
import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import type { DiscoverySearch } from "@/app/routes/discovery";
import { leadWebUrl } from "../lib/leadLinks";
import { DISCOVERY_SOURCE_LABELS } from "../sourceConfig";
import type { Lead } from "../types";
import {
  leadOwner,
  LEAD_TABLE_COLUMNS,
  stableLeadOrder,
  type LeadRowColumn,
} from "./LeadFilters";
import { LeadLink } from "./LeadLink";

export type LeadTableView = "list" | "grid";

export type LeadTableProps = {
  leads: readonly Lead[];
  view: LeadTableView;
  scope: "campaign" | "global";
  search: DiscoverySearch;
};

export type LeadTableRow = {
  lead: Lead;
  columns: Record<LeadRowColumn, string>;
};

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function statusVariant(status: Lead["status"]) {
  if (status === "qualified" || status === "client_active")
    return "success" as const;
  if (status === "accepted") return "info" as const;
  if (status === "dormant") return "warning" as const;
  if (status === "disqualified") return "destructive" as const;
  return "secondary" as const;
}

/** The stable, screenshot-aligned row view model used by both table surfaces. */
export function leadTableRows(leads: readonly Lead[]): LeadTableRow[] {
  return stableLeadOrder(leads).map((lead) => ({
    lead,
    columns: {
      company: lead.companyName,
      location: lead.location,
      source: DISCOVERY_SOURCE_LABELS[lead.source],
      contacts: String(lead.contacts),
      "owner-score": `${leadOwner(lead)} · ${lead.score}`,
      added: formatDate(lead.addedAt),
      status: lead.status,
    },
  }));
}

const columnLabels: Record<LeadRowColumn, string> = {
  company: "Company",
  location: "Location",
  source: "Source",
  contacts: "Contacts",
  "owner-score": "Owner / Score",
  added: "Added",
  status: "Status",
};

function LeadContact({
  lead,
  onInteract,
}: {
  lead: Lead;
  onInteract?: (event: React.MouseEvent) => void;
}) {
  const websiteUrl = leadWebUrl(lead.website);
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-muted-foreground">
      {websiteUrl ? (
        <LeadLink
          className="inline-flex items-center gap-1 hover:text-foreground"
          href={websiteUrl}
          onClick={onInteract}
        >
          <Globe2 aria-hidden="true" className="h-3 w-3" />
          Website
          <ExternalLink aria-hidden="true" className="h-3 w-3" />
        </LeadLink>
      ) : null}
      {lead.email ? (
        <span className="inline-flex items-center gap-1">
          <Mail aria-hidden="true" className="h-3 w-3" />
          {lead.email}
        </span>
      ) : null}
      {lead.phone ? (
        <span className="inline-flex items-center gap-1">
          <Phone aria-hidden="true" className="h-3 w-3" />
          {lead.phone}
        </span>
      ) : null}
    </div>
  );
}

function LeadGrid({
  leads,
  onOpenLead,
}: {
  leads: readonly Lead[];
  onOpenLead: (leadId: string) => void;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {stableLeadOrder(leads).map((lead) => (
        <Card
          className="cursor-pointer border-border/60 bg-card/70 p-4 shadow-none transition-colors hover:bg-card"
          data-testid={`lead-card-${lead.id}`}
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
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-foreground">
                {lead.companyName}
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {lead.location}
              </p>
            </div>
            <Badge variant={statusVariant(lead.status)}>{lead.status}</Badge>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
            <div>
              <p className="text-muted-foreground">Source</p>
              <p className="mt-0.5 text-foreground">
                {DISCOVERY_SOURCE_LABELS[lead.source]}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Contacts</p>
              <p className="mt-0.5 text-foreground">{lead.contacts}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Owner</p>
              <p className="mt-0.5 text-foreground">{leadOwner(lead)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Score</p>
              <p className="mt-0.5 text-foreground">{lead.score}</p>
            </div>
          </div>
          <LeadContact
            lead={lead}
            onInteract={(event) => event.stopPropagation()}
          />
        </Card>
      ))}
    </div>
  );
}

export function LeadTable({ leads, scope, search, view }: LeadTableProps) {
  const { goDiscovery } = useAppNavigation();
  const openLead = React.useCallback(
    (leadId: string) => {
      void goDiscovery({ ...search, leadId });
    },
    [goDiscovery, search],
  );
  const rows = leadTableRows(leads);
  if (rows.length === 0) {
    return (
      <Card className="border-dashed border-border/70 bg-background/30 p-8 text-center shadow-none">
        <h2 className="text-base font-semibold text-foreground">
          No leads match these filters
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Clear a filter or adjust the search to see {scope} leads.
        </p>
      </Card>
    );
  }
  if (view === "grid") return <LeadGrid leads={leads} onOpenLead={openLead} />;

  return (
    <Card className="overflow-hidden border-border/60 bg-card/70 p-0 shadow-none">
      <div className="overflow-x-auto">
        <table
          className="w-full min-w-[58rem] text-sm"
          data-testid={`${scope}-lead-table`}
        >
          <caption className="sr-only">
            {scope === "campaign" ? "Campaign" : "Global"} leads
          </caption>
          <thead className="bg-muted/25 text-left text-2xs uppercase tracking-[0.14em] text-muted-foreground">
            <tr>
              <th className="w-10 px-4 py-3" scope="col">
                <input aria-label="Select all leads" type="checkbox" />
              </th>
              {LEAD_TABLE_COLUMNS.map((column) => (
                <th className="px-4 py-3 font-medium" key={column} scope="col">
                  {columnLabels[column]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ columns, lead }) => (
              <tr
                className="cursor-pointer border-t border-border/50 align-top transition-colors hover:bg-muted/30"
                data-testid={`lead-row-${lead.id}`}
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
                    aria-label={`Select ${lead.companyName}`}
                    onClick={(event) => event.stopPropagation()}
                    type="checkbox"
                  />
                </td>
                <th
                  className="px-4 py-3 text-left font-medium text-foreground"
                  scope="row"
                >
                  <div>{columns.company}</div>
                  <LeadContact
                    lead={lead}
                    onInteract={(event) => event.stopPropagation()}
                  />
                </th>
                <td className="px-4 py-3 text-muted-foreground">
                  {columns.location}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {columns.source}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {columns.contacts}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  <div>{leadOwner(lead)}</div>
                  <div className="mt-1 tabular-nums text-foreground">
                    {lead.score}
                  </div>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                  {columns.added}
                </td>
                <td className="px-4 py-3">
                  <Badge variant={statusVariant(lead.status)}>
                    <span aria-hidden="true" className="mr-1">
                      ●
                    </span>
                    {columns.status}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
