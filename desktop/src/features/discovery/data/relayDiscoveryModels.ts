import {
  DISCOVERY_SOURCE_LABELS,
  type CampaignSourceConfig,
  type DiscoverySource,
  isLiveDiscoverySource,
} from "../sourceConfig";
import type {
  CampaignDetail,
  CampaignStatus,
  DiscoveryRun,
  Lead,
  SourceMetric,
  SourceStatus,
} from "../types";

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

export type RunSourceProjection = {
  source: DiscoverySource;
  provider: "outscraper" | "brave_search" | "exa_search";
  position: number;
  status:
    | "pending"
    | "active"
    | "completed"
    | "exhausted"
    | "failed"
    | "cancelled"
    | "outcome_unknown"
    | "skipped_target_met";
  request_cursor: string | null;
  request_count: number;
  returned_count: number;
  retained_count: number;
  duplicate_count: number;
  failure_class: string | null;
  started_at: string | null;
  finished_at: string | null;
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
  source_config?: {
    mode: CampaignSourceConfig["mode"];
    sources: DiscoverySource[];
  };
  lead_count: number;
  latest_run: RunProjection | null;
  latest_run_sources?: RunSourceProjection[];
  created_at: string;
  updated_at: string;
};

export type LeadProjection = {
  lead_id: string;
  campaign_id: string;
  industry_id: string;
  vertical_id: string;
  provider: "outscraper" | "brave_search" | "exa_search";
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

export function campaignSourceConfig(
  campaign: CampaignProjection,
): CampaignSourceConfig {
  const config = campaign.source_config;
  if (
    !config ||
    (config.mode !== "waterfall" && config.mode !== "concurrent") ||
    config.sources.length === 0 ||
    config.sources.some((source) => !isLiveDiscoverySource(source))
  ) {
    return { ...LIVE_SOURCE_CONFIG, order: [...LIVE_SOURCE_CONFIG.order] };
  }
  return { mode: config.mode, order: [...config.sources] };
}

function metricStatus(status: RunSourceProjection["status"]): SourceStatus {
  if (status === "active") return "active";
  if (status === "completed") return "sampled";
  if (status === "failed" || status === "outcome_unknown") return "failed";
  if (status === "skipped_target_met") return "skipped";
  if (status === "exhausted" || status === "cancelled") return "exhausted";
  return "pending";
}

function safeFailureCopy(source: RunSourceProjection): string | undefined {
  if (!source.failure_class) return undefined;
  if (source.failure_class === "credential_rejected") {
    return "The provider rejected its saved API key.";
  }
  if (source.failure_class === "billing_required") {
    return "The provider account requires billing or available credit.";
  }
  if (source.failure_class === "rate_limited") {
    return "The provider rate limit was reached.";
  }
  if (source.failure_class === "outcome_unknown") {
    return "The paid request outcome could not be confirmed and was not repeated.";
  }
  if (source.failure_class === "cancelled") return "The source was cancelled.";
  return `The source stopped (${source.failure_class.replaceAll("_", " ")}).`;
}

export function sourceMetric(source: RunSourceProjection): SourceMetric {
  const rejected = Math.max(
    0,
    source.returned_count - source.retained_count - source.duplicate_count,
  );
  const acceptance =
    source.returned_count > 0
      ? Math.round((source.retained_count / source.returned_count) * 100)
      : 0;
  const start = source.started_at ? Date.parse(source.started_at) : Number.NaN;
  const finish = source.finished_at
    ? Date.parse(source.finished_at)
    : Number.NaN;
  return {
    source: source.source,
    status: metricStatus(source.status),
    requests: source.request_count,
    discovered: source.returned_count,
    stored: source.retained_count,
    rejected,
    duplicates: source.duplicate_count,
    quality: acceptance,
    acceptance,
    ...(Number.isFinite(start) && Number.isFinite(finish)
      ? { durationMs: Math.max(0, finish - start) }
      : {}),
    ...(safeFailureCopy(source) ? { error: safeFailureCopy(source) } : {}),
  };
}

export function sourceMetrics(campaign: CampaignProjection): SourceMetric[] {
  const persisted = [...(campaign.latest_run_sources ?? [])].sort(
    (left, right) => left.position - right.position,
  );
  if (persisted.length > 0) return persisted.map(sourceMetric);
  return campaignSourceConfig(campaign).order.map((source) => ({
    source,
    status: "pending",
    discovered: 0,
    stored: 0,
    rejected: 0,
    duplicates: 0,
    quality: 0,
    acceptance: 0,
  }));
}

export function mapRun(campaign: CampaignProjection): DiscoveryRun {
  const run = campaign.latest_run;
  const metrics = sourceMetrics(campaign);
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
      sourceMetrics: metrics,
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
  const discovered = metrics.reduce(
    (sum, metric) => sum + metric.discovered,
    0,
  );
  const stored = metrics.reduce((sum, metric) => sum + metric.stored, 0);
  const rejected = metrics.reduce((sum, metric) => sum + metric.rejected, 0);
  const duplicates = metrics.reduce(
    (sum, metric) => sum + metric.duplicates,
    0,
  );
  const terminalSources = metrics.filter((metric) =>
    ["sampled", "exhausted", "failed", "skipped"].includes(metric.status),
  ).length;
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
    discovered,
    stored,
    rejected,
    duplicates,
    completion:
      metrics.length > 0
        ? Math.round((terminalSources / metrics.length) * 100)
        : run.total_steps > 0
          ? Math.min(
              100,
              Math.round((run.completed_steps / run.total_steps) * 100),
            )
          : 0,
    targetReached: campaign.lead_count >= campaign.target,
    currentSource: metrics.find((metric) => metric.status === "active")?.source,
    sourceMetrics: metrics,
    startedAt: run.created_at,
    completedAt:
      run.state === "succeeded" ||
      run.state === "cancelled" ||
      run.state === "failed"
        ? run.updated_at
        : undefined,
    error:
      run.state === "failed"
        ? (metrics.find((metric) => metric.error)?.error ??
          "Discovery stopped because every selected source failed.")
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
    sourceConfig: campaignSourceConfig(campaign),
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

function sourceForProvider(
  provider: LeadProjection["provider"],
): DiscoverySource {
  if (provider === "brave_search") return "brave_search";
  if (provider === "exa_search") return "exa_search";
  return "google_maps";
}

export function mapLead(lead: LeadProjection): Lead {
  const source = sourceForProvider(lead.provider);
  return {
    id: lead.lead_id,
    entityType: "company",
    companyName: lead.name,
    contacts: lead.phone ? 1 : 0,
    location: leadLocation(lead),
    source,
    sourceLabel: DISCOVERY_SOURCE_LABELS[source],
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
