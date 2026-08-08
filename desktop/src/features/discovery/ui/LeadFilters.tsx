import type * as React from "react";
import { Search, SlidersHorizontal } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { DISCOVERY_SOURCE_LABELS } from "../sourceConfig";
import type { Lead, LeadFunnelStatus } from "../types";

export type LeadMode = "companies" | "people";
export type LeadQualityFilter = "all" | "high" | "needs-review";
export type LeadStatusFilter = "all" | LeadFunnelStatus;

/**
 * The score that separates "high quality" from "needs review".
 *
 * Shared with the Leads stats tile so the filter and the tile cannot drift
 * apart.
 */
export const HIGH_QUALITY_SCORE_THRESHOLD = 80;

export type LeadFilterState = {
  search: string;
  industryId: string;
  location: string;
  status: LeadStatusFilter;
  owner: string;
  channel: string;
  quality: LeadQualityFilter;
};

export const EMPTY_LEAD_FILTERS: LeadFilterState = {
  search: "",
  industryId: "all",
  location: "all",
  status: "all",
  owner: "all",
  channel: "all",
  quality: "all",
};

export type LeadRowColumn =
  | "company"
  | "location"
  | "source"
  | "contacts"
  | "owner-score"
  | "added"
  | "status";

export const LEAD_TABLE_COLUMNS: readonly LeadRowColumn[] = [
  "company",
  "location",
  "source",
  "contacts",
  "owner-score",
  "added",
  "status",
];

export function resolveLeadMode(value: string): LeadMode {
  return value === "people" ? "people" : "companies";
}

function normalized(value: string | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

export function leadOwner(lead: Lead): string {
  return lead.owner?.trim() || "Unassigned";
}

export function leadMatchesFilters(
  lead: Lead,
  filters: LeadFilterState,
): boolean {
  const query = normalized(filters.search);
  if (
    query &&
    ![
      lead.companyName,
      lead.company,
      lead.contactName,
      lead.contactTitle,
      lead.personName,
      lead.headline,
      lead.roleName,
      lead.currentCompany,
      lead.seniority,
      lead.location,
      lead.email,
      lead.phone,
    ]
      .filter(Boolean)
      .some((value) => normalized(value).includes(query))
  ) {
    return false;
  }
  if (filters.industryId !== "all" && lead.industryId !== filters.industryId)
    return false;
  if (
    filters.location !== "all" &&
    normalized(lead.location) !== normalized(filters.location)
  )
    return false;
  if (filters.owner !== "all" && leadOwner(lead) !== filters.owner)
    return false;
  if (filters.channel !== "all" && lead.source !== filters.channel)
    return false;
  if (filters.quality === "high" && lead.score < HIGH_QUALITY_SCORE_THRESHOLD)
    return false;
  if (
    filters.quality === "needs-review" &&
    lead.score >= HIGH_QUALITY_SCORE_THRESHOLD
  )
    return false;
  return true;
}

/**
 * The status the workspace fetches for, or undefined for "all statuses".
 *
 * The relay owns status filtering, so the client-side filter deliberately
 * ignores status and the fetch scope carries it instead.
 */
export function selectedLeadStatus(
  filters: LeadFilterState,
): LeadFunnelStatus | undefined {
  return filters.status === "all" ? undefined : filters.status;
}

/** Filter without mutating the adapter's stable lead ordering. */
export function filterLeads(
  leads: readonly Lead[],
  filters: LeadFilterState = EMPTY_LEAD_FILTERS,
): Lead[] {
  return leads.filter((lead) => leadMatchesFilters(lead, filters));
}

/** A named helper makes the stable ordering contract explicit for consumers. */
export function stableLeadOrder(leads: readonly Lead[]): Lead[] {
  return leads.map((lead) => lead);
}

export function leadFilterOptions(leads: readonly Lead[]) {
  return {
    industries: [...new Set(leads.map((lead) => lead.industryId))],
    locations: [...new Set(leads.map((lead) => lead.location))],
    owners: [...new Set(leads.map(leadOwner))],
    channels: [...new Set(leads.map((lead) => lead.source))],
  };
}

type LeadFiltersProps = {
  leads: readonly Lead[];
  value: LeadFilterState;
  onChange: (next: Partial<LeadFilterState>) => void;
  campaign?: boolean;
  people?: boolean;
};

function SelectFilter({
  "aria-label": ariaLabel,
  children,
  onChange,
  value,
}: {
  "aria-label": string;
  children: React.ReactNode;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="flex h-9 items-center gap-2 rounded-lg border border-input/40 bg-background px-3 text-sm text-muted-foreground">
      <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
      <span className="sr-only">{ariaLabel}</span>
      <select
        aria-label={ariaLabel}
        className="max-w-40 bg-transparent text-sm text-foreground outline-hidden"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {children}
      </select>
    </label>
  );
}

export function LeadFilters({
  campaign = false,
  people = false,
  leads,
  onChange,
  value,
}: LeadFiltersProps) {
  const options = leadFilterOptions(leads);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label
          className="relative min-w-56 flex-1 sm:max-w-xl"
          htmlFor="lead-search"
        >
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search leads"
            className="pl-9"
            id="lead-search"
            onChange={(event) => onChange({ search: event.target.value })}
            placeholder={
              people
                ? "Search people, roles, companies, locations..."
                : "Search companies, brands, locations..."
            }
            value={value.search}
          />
        </label>
        <Button
          onClick={() => onChange(EMPTY_LEAD_FILTERS)}
          size="sm"
          type="button"
          variant="outline"
        >
          Clear filters
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {campaign ? (
          <SelectFilter
            aria-label="Filter lead quality"
            onChange={(quality) =>
              onChange({ quality: quality as LeadQualityFilter })
            }
            value={value.quality}
          >
            <option value="all">All quality</option>
            <option value="high">High quality</option>
            <option value="needs-review">Needs review</option>
          </SelectFilter>
        ) : null}
        <SelectFilter
          aria-label="Filter lead status"
          onChange={(status) =>
            onChange({ status: status as LeadStatusFilter })
          }
          value={value.status}
        >
          <option value="all">All statuses</option>
          <option value="candidate">Candidate</option>
          <option value="accepted">Accepted</option>
          <option value="qualified">Qualified</option>
          <option value="dormant">Dormant</option>
          <option value="disqualified">Disqualified</option>
          <option value="client_active">Converted</option>
        </SelectFilter>
        <SelectFilter
          aria-label="Filter lead industry"
          onChange={(industryId) => onChange({ industryId })}
          value={value.industryId}
        >
          <option value="all">All industries</option>
          {options.industries.map((industry) => (
            <option key={industry} value={industry}>
              {industry}
            </option>
          ))}
        </SelectFilter>
        <SelectFilter
          aria-label="Filter lead location"
          onChange={(location) => onChange({ location })}
          value={value.location}
        >
          <option value="all">All locations</option>
          {options.locations.map((location) => (
            <option key={location} value={location}>
              {location}
            </option>
          ))}
        </SelectFilter>
        <SelectFilter
          aria-label="Filter lead channel"
          onChange={(channel) => onChange({ channel })}
          value={value.channel}
        >
          <option value="all">All channels</option>
          {options.channels.map((channel) => (
            <option key={channel} value={channel}>
              {DISCOVERY_SOURCE_LABELS[
                channel as keyof typeof DISCOVERY_SOURCE_LABELS
              ] ?? channel}
            </option>
          ))}
        </SelectFilter>
        <SelectFilter
          aria-label="Filter lead owner"
          onChange={(owner) => onChange({ owner })}
          value={value.owner}
        >
          <option value="all">All owners</option>
          {options.owners.map((owner) => (
            <option key={owner} value={owner}>
              {owner}
            </option>
          ))}
        </SelectFilter>
      </div>
    </div>
  );
}
