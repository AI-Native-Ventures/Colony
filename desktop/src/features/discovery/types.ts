import type { CampaignSourceConfig, DiscoverySource } from "./sourceConfig";

export type DiscoveryEntityStatus =
  | "active"
  | "available"
  | "draft"
  | "ready"
  | "running"
  | "completed"
  | "partial"
  | "cancelled"
  | "failed";

export type Industry = {
  id: string;
  slug: string;
  name: string;
  description?: string;
  imageKey: string;
  verticalCount: number;
  leadCount: number;
  campaignCount: number;
  status: "active" | "available";
};

export type Vertical = {
  id: string;
  slug: string;
  industryId: string;
  name: string;
  description?: string;
  imageKey: string;
  campaignCount: number;
  leadCount: number;
  status: "active" | "available";
};

export type VerticalDetail = Vertical & {
  campaigns: CampaignSummary[];
};

export type CampaignStatus =
  | "draft"
  | "ready"
  | "running"
  | "completed"
  | "partial"
  | "cancelled"
  | "failed";

export type CampaignSummary = {
  id: string;
  name: string;
  industryId: string;
  verticalId: string;
  industryName: string;
  verticalName: string;
  location: string;
  description?: string;
  status: CampaignStatus;
  target: number;
  targetLeads: number;
  leadCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CampaignDetail = CampaignSummary & {
  sourceConfig: CampaignSourceConfig;
  run?: DiscoveryRun;
  metrics: {
    companiesFound: number;
    contactsFound: number;
    emailsFound: number;
    missingWebsites: number;
  };
};

export type CampaignDraft = {
  name: string;
  industryId: string;
  verticalId: string;
  location: string;
  target: number;
  description?: string;
  sourceConfig?: CampaignSourceConfig;
};

export type LeadStatus = "new" | "enriched" | "qualified" | "rejected";

export type Lead = {
  id: string;
  companyName: string;
  company?: string;
  contactName?: string;
  contactTitle?: string;
  contacts: number;
  location: string;
  source: DiscoverySource;
  sourceLabel: string;
  website?: string;
  phone?: string;
  email?: string;
  owner?: string;
  score: number;
  industryId: string;
  verticalId: string;
  campaignIds: string[];
  status: LeadStatus;
  addedAt: string;
};

export type LeadScope = {
  scope?: "campaign" | "global";
  /** Optional aliases make the adapter easy to bridge to route/search state. */
  kind?: "campaign" | "global";
  type?: "campaign" | "global";
  campaignId?: string;
  industryId?: string;
  verticalId?: string;
  search?: string;
  status?: LeadStatus;
  page?: number;
  pageSize?: number;
};

export type LeadPage = {
  leads: Lead[];
  total: number;
  page: number;
  pageSize: number;
  hasNextPage: boolean;
};

export type DiscoveryPhase =
  | "initializing"
  | "sampling"
  | "evaluating"
  | "focused_discovery"
  | "fallback"
  | "completed"
  | "failed";

export type SourceStatus =
  | "pending"
  | "sampling"
  | "sampled"
  | "active"
  | "exhausted"
  | "failed"
  | "skipped";

export type SourceMetric = {
  source: DiscoverySource;
  status: SourceStatus;
  discovered: number;
  stored: number;
  rejected: number;
  duplicates: number;
  quality: number;
  acceptance: number;
  durationMs?: number;
  error?: string;
};

export type DiscoveryRunStatus =
  | "idle"
  | "running"
  | "completed"
  | "partial"
  | "cancelled"
  | "failed";

export type DiscoveryRun = {
  id: string;
  campaignId: string;
  status: DiscoveryRunStatus;
  phase: DiscoveryPhase;
  target: number;
  discovered: number;
  stored: number;
  rejected: number;
  duplicates: number;
  completion: number;
  targetReached: boolean;
  currentSource?: DiscoverySource;
  sourceMetrics: SourceMetric[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
};

export type DiscoveryEventBase = {
  campaignId: string;
  runId: string;
  at: string;
  run: DiscoveryRun;
};

export type SourceDiscoveryEvent = DiscoveryEventBase & {
  source: DiscoverySource;
  metric: SourceMetric;
  sourceMetric: SourceMetric;
};

export type DiscoveryEvent =
  | (DiscoveryEventBase & { type: "session_started" })
  | (SourceDiscoveryEvent & { type: "source_started" })
  | (SourceDiscoveryEvent & {
      type: "source_progress";
      progress: number;
      message?: string;
    })
  | (SourceDiscoveryEvent & { type: "source_completed" })
  | (SourceDiscoveryEvent & { type: "source_exhausted" })
  | (SourceDiscoveryEvent & { type: "source_failed"; error: string })
  | (SourceDiscoveryEvent & { type: "source_skipped"; reason: string })
  | (DiscoveryEventBase & {
      type: "fallback_activated";
      fromSource?: DiscoverySource;
      source?: DiscoverySource;
    })
  | (SourceDiscoveryEvent & {
      type: "lead_stored";
      lead: Lead;
    })
  | (SourceDiscoveryEvent & {
      type: "lead_rejected";
      lead?: Lead;
      reason: string;
    })
  | (DiscoveryEventBase & { type: "target_reached"; targetReached: true })
  | (DiscoveryEventBase & {
      type: "session_completed";
      targetReached: boolean;
      partial: boolean;
    })
  | (DiscoveryEventBase & { type: "session_cancelled" })
  | (DiscoveryEventBase & { type: "session_failed"; error: string });
