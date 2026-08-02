import type {
  CampaignDetail,
  CampaignStatus,
  DiscoveryRun,
  Lead,
  SourceMetric,
} from "../types";
import type { CampaignSourceConfig } from "../sourceConfig";

export const LIVE_SOURCE_CONFIG: CampaignSourceConfig = {
  mode: "waterfall",
  order: ["google_maps"],
};

export type RunProjection = {
  run_id: string;
  campaign_id: string;
  state: "queued" | "running" | "succeeded" | "cancelled" | "failed";
  completed_steps: number;
  total_steps: number;
  cancel_requested: boolean;
  terminal_reason:
    | "cancelled_by_actor"
    | "entitlement_revoked"
    | "executor_failed"
    | null;
  created_at: string;
  updated_at: string;
};

export type CampaignProjection = {
  campaign_id: string;
  name: string;
  industry_id: string;
  industry_name: string;
  vertical_id: string;
  vertical_name: string;
  query: string;
  location: string;
  target: number;
  description: string | null;
  language: string;
  region: string | null;
  lead_count: number;
  latest_run: RunProjection | null;
  created_at: string;
  updated_at: string;
};

export type LeadProjection = {
  lead_id: string;
  campaign_id: string;
  industry_id: string;
  vertical_id: string;
  name: string;
  website: string | null;
  phone: string | null;
  full_address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  category: string | null;
  subtypes: string[];
  rating_hundredths: number | null;
  reviews_count: number | null;
  source_url: string | null;
  image_url: string | null;
  added_at: string;
};

export function sourceMetric(campaign: CampaignProjection): SourceMetric {
  const run = campaign.latest_run;
  const terminal = run?.state === "succeeded";
  return {
    source: "google_maps",
    status: terminal
      ? "sampled"
      : run?.state === "failed"
        ? "failed"
        : run?.state === "cancelled"
          ? "exhausted"
          : run
            ? "active"
            : "pending",
    discovered: campaign.lead_count,
    stored: campaign.lead_count,
    rejected: 0,
    duplicates: 0,
    quality: 0,
    acceptance: campaign.lead_count > 0 ? 100 : 0,
  };
}

export function mapRun(campaign: CampaignProjection): DiscoveryRun {
  const run = campaign.latest_run;
  if (!run) {
    return {
      id: `${campaign.campaign_id}-not-started`,
      campaignId: campaign.campaign_id,
      status: "idle",
      phase: "initializing",
      target: campaign.target,
      discovered: 0,
      stored: 0,
      rejected: 0,
      duplicates: 0,
      completion: 0,
      targetReached: false,
      sourceMetrics: [sourceMetric(campaign)],
    };
  }
  const status =
    run.state === "succeeded"
      ? campaign.lead_count >= campaign.target
        ? "completed"
        : "partial"
      : run.state === "cancelled"
        ? "cancelled"
        : run.state === "failed"
          ? "failed"
          : "running";
  return {
    id: run.run_id,
    campaignId: campaign.campaign_id,
    status,
    phase:
      run.state === "queued"
        ? "initializing"
        : run.state === "running"
          ? "focused_discovery"
          : run.state === "failed"
            ? "failed"
            : "completed",
    target: campaign.target,
    discovered: campaign.lead_count,
    stored: campaign.lead_count,
    rejected: 0,
    duplicates: 0,
    completion:
      run.total_steps > 0
        ? Math.min(
            100,
            Math.round((run.completed_steps / run.total_steps) * 100),
          )
        : 0,
    targetReached: campaign.lead_count >= campaign.target,
    currentSource:
      run.state === "queued" || run.state === "running"
        ? "google_maps"
        : undefined,
    sourceMetrics: [sourceMetric(campaign)],
    startedAt: run.created_at,
    completedAt:
      run.state === "succeeded" ||
      run.state === "cancelled" ||
      run.state === "failed"
        ? run.updated_at
        : undefined,
    error:
      run.state === "failed"
        ? "Discovery stopped because the connected source could not complete the run."
        : run.terminal_reason === "entitlement_revoked"
          ? "Discovery stopped because LAKA access is no longer active."
          : undefined,
  };
}

function campaignStatus(campaign: CampaignProjection): CampaignStatus {
  const state = campaign.latest_run?.state;
  if (!state) return "ready";
  if (state === "queued" || state === "running") return "running";
  if (state === "cancelled") return "cancelled";
  if (state === "failed") return "failed";
  return campaign.lead_count >= campaign.target ? "completed" : "partial";
}

export function mapCampaign(campaign: CampaignProjection): CampaignDetail {
  return {
    id: campaign.campaign_id,
    name: campaign.name,
    targetType: "business",
    industryId: campaign.industry_id,
    verticalId: campaign.vertical_id,
    industryName: campaign.industry_name,
    verticalName: campaign.vertical_name,
    location: campaign.location,
    description: campaign.description ?? undefined,
    status: campaignStatus(campaign),
    target: campaign.target,
    targetLeads: campaign.target,
    leadCount: campaign.lead_count,
    createdAt: campaign.created_at,
    updatedAt: campaign.updated_at,
    sourceConfig: LIVE_SOURCE_CONFIG,
    run: mapRun(campaign),
    metrics: {
      companiesFound: campaign.lead_count,
      contactsFound: 0,
      emailsFound: 0,
      missingWebsites: 0,
    },
  };
}

function leadLocation(lead: LeadProjection): string {
  if (lead.full_address) return lead.full_address;
  const location = [lead.city, lead.state, lead.country]
    .filter(Boolean)
    .join(", ");
  return location || "Location unavailable";
}

export function mapLead(lead: LeadProjection): Lead {
  return {
    id: lead.lead_id,
    entityType: "company",
    companyName: lead.name,
    contacts: lead.phone ? 1 : 0,
    location: leadLocation(lead),
    source: "google_maps",
    sourceLabel: "Outscraper / Google Maps",
    website: lead.website ?? undefined,
    phone: lead.phone ?? undefined,
    score: 0,
    industryId: lead.industry_id,
    verticalId: lead.vertical_id,
    campaignIds: [lead.campaign_id],
    status: "new",
    addedAt: lead.added_at,
  };
}

export function isTerminal(run: RunProjection): boolean {
  return (
    run.state === "succeeded" ||
    run.state === "cancelled" ||
    run.state === "failed"
  );
}

export function eventBase(campaign: CampaignProjection) {
  const run = mapRun(campaign);
  return {
    campaignId: campaign.campaign_id,
    runId: run.id,
    at: campaign.latest_run?.updated_at ?? new Date().toISOString(),
    run,
  };
}
