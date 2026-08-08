import { Building2, Database, Mail, MapPin, Users } from "lucide-react";

import { Card } from "@/shared/ui/card";
import type { Lead } from "../types";
import { HIGH_QUALITY_SCORE_THRESHOLD } from "./LeadFilters";
import { MetricCard } from "./MetricCard";

export type CampaignLeadStats = {
  companiesFound: number;
  contactsFound: number;
  emailsFound: number;
  missingWebsites: number;
};

export type GlobalLeadStats = {
  totalLeads: number;
  highQualityLeads: number;
  newThisWeek: number;
  topIndustry: string;
};

export function campaignLeadStats(leads: readonly Lead[]): CampaignLeadStats {
  return {
    companiesFound: leads.length,
    contactsFound: leads.reduce((total, lead) => total + lead.contacts, 0),
    emailsFound: leads.filter((lead) => Boolean(lead.email)).length,
    missingWebsites: leads.filter((lead) => !lead.website).length,
  };
}

function readableIndustry(value: string) {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function globalLeadStats(
  leads: readonly Lead[],
  now = new Date(),
): GlobalLeadStats {
  const weekAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const counts = new Map<string, number>();
  for (const lead of leads) {
    counts.set(lead.industryId, (counts.get(lead.industryId) ?? 0) + 1);
  }
  const topIndustryId = [...counts.entries()].sort(
    ([firstIndustry, firstCount], [secondIndustry, secondCount]) =>
      secondCount - firstCount || firstIndustry.localeCompare(secondIndustry),
  )[0]?.[0];
  return {
    totalLeads: leads.length,
    highQualityLeads: leads.filter(
      (lead) => lead.score >= HIGH_QUALITY_SCORE_THRESHOLD,
    ).length,
    newThisWeek: leads.filter((lead) => {
      const added = new Date(lead.addedAt).getTime();
      return (
        Number.isFinite(added) && added >= weekAgo && added <= now.getTime()
      );
    }).length,
    topIndustry: topIndustryId ? readableIndustry(topIndustryId) : "—",
  };
}

export function CampaignLeadStatsRow({
  leads,
  people = false,
}: {
  leads: readonly Lead[];
  people?: boolean;
}) {
  const stats = campaignLeadStats(leads);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border/60 bg-card/70 px-4 py-3 text-sm">
      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
        <Users aria-hidden="true" className="h-4 w-4 text-emerald-600" />
        {stats.companiesFound} {people ? "people" : "companies"} found
      </span>
      <span aria-hidden="true" className="text-muted-foreground">
        ·
      </span>
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Users aria-hidden="true" className="h-4 w-4" />
        {people
          ? leads.filter((lead) => Boolean(lead.currentCompany)).length
          : stats.contactsFound}{" "}
        {people ? "current companies" : "contacts"}
      </span>
      <span className="inline-flex items-center gap-1.5 text-emerald-600">
        <Mail aria-hidden="true" className="h-4 w-4" />
        {stats.emailsFound} emails
      </span>
      <span className="inline-flex items-center gap-1.5 text-amber-600">
        <MapPin aria-hidden="true" className="h-4 w-4" />
        {people
          ? leads.filter((lead) => Boolean(lead.linkedinUrl)).length
          : stats.missingWebsites}{" "}
        {people ? "LinkedIn profiles" : "missing websites"}
      </span>
    </div>
  );
}

export function GlobalLeadStatsRow({
  leads,
  people = false,
}: {
  leads: readonly Lead[];
  people?: boolean;
}) {
  const stats = globalLeadStats(leads);
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard
        icon={<Users aria-hidden="true" />}
        label="Total Leads"
        value={stats.totalLeads}
        hint={people ? "Discovered professionals" : "Discovered companies"}
      />
      <MetricCard
        icon={<Database aria-hidden="true" />}
        label="High Quality"
        value={stats.highQualityLeads}
        hint={`${stats.totalLeads ? Math.round((stats.highQualityLeads / stats.totalLeads) * 100) : 0}% high quality`}
      />
      <MetricCard
        icon={<Building2 aria-hidden="true" />}
        label="New This Week"
        value={stats.newThisWeek}
        hint="Last 7 days"
      />
      <MetricCard
        icon={<Building2 aria-hidden="true" />}
        label={people ? "Top Field" : "Top Industry"}
        value={stats.topIndustry}
        hint={`${stats.topIndustry === "—" ? 0 : leads.filter((lead) => readableIndustry(lead.industryId) === stats.topIndustry).length} ${people ? "people" : "companies"}`}
      />
    </div>
  );
}

export function LeadsEmptyState() {
  return (
    <Card className="border-dashed border-border/70 bg-background/30 p-8 text-center shadow-none">
      <Users
        aria-hidden="true"
        className="mx-auto h-8 w-8 text-muted-foreground"
      />
      <h2 className="mt-3 text-base font-semibold text-foreground">
        No leads found
      </h2>
      <p className="mx-auto mt-1 max-w-xl text-sm text-muted-foreground">
        Run discovery or adjust your filters to add leads to this workspace.
      </p>
    </Card>
  );
}
