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

export type DiscoveryTargetType = "business" | "individual";

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

export type ProfessionalField = {
  id: string;
  slug: string;
  name: string;
  displayName?: string;
  description?: string;
  imageKey: string;
  roleCount: number;
  leadCount: number;
  campaignCount: number;
  status: "active" | "available";
};

export type ProfessionalRole = {
  id: string;
  slug: string;
  fieldId: string;
  name: string;
  description?: string;
  imageKey: string;
  campaignCount: number;
  leadCount: number;
  status: "active" | "available";
};

export type ProfessionalRoleDetail = ProfessionalRole & {
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
  targetType?: DiscoveryTargetType;
  industryId: string;
  verticalId: string;
  industryName: string;
  verticalName: string;
  fieldId?: string;
  roleId?: string;
  fieldName?: string;
  roleName?: string;
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
  budget?: CampaignBudget;
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
  targetType?: DiscoveryTargetType;
  industryId: string;
  verticalId: string;
  fieldId?: string;
  roleId?: string;
  location: string;
  target: number;
  description?: string;
  /** Preview-only source selection retained for individual Discovery fixtures. */
  sourceConfig?: CampaignSourceConfig;
};

export type CampaignBudget = {
  state: "unapproved" | "active" | "paused" | "revoked" | "exhausted";
  payerPubkey?: string;
  approvedNanousd: string;
  spentNanousd: string;
  reservedNanousd: string;
  remainingNanousd: string;
  pricePerRetainedLeadNanousd?: string;
  approvedAt?: string;
};

/** Funnel status vocabulary mirroring the Party relationship lifecycle. */
export type LeadFunnelStatus =
  | "candidate"
  | "accepted"
  | "qualified"
  | "dormant"
  | "disqualified"
  | "client_active";

/** The Pipeline columns in lifecycle order: entry to terminal to client. */
export const PIPELINE_COLUMN_STATUSES: readonly LeadFunnelStatus[] = [
  "candidate",
  "accepted",
  "qualified",
  "dormant",
  "disqualified",
  "client_active",
];

/** One retained Lead plus its editable profile. */
export type LeadDetail = Lead & {
  notes?: string;
  updatedAt?: string;
};

/** Editable fields for `updateLead`. */
export type LeadUpdateInput = {
  website?: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  contactName?: string;
  contactTitle?: string;
  notes?: string;
  score?: number;
  owner?: string;
  status?: LeadFunnelStatus;
};

export type Lead = {
  id: string;
  entityType?: "company" | "person";
  companyName: string;
  company?: string;
  contactName?: string;
  contactTitle?: string;
  personName?: string;
  headline?: string;
  roleName?: string;
  currentCompany?: string;
  seniority?: string;
  linkedinUrl?: string;
  avatarUrl?: string;
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
  status: LeadFunnelStatus;
  addedAt: string;
  /**
   * The Colony Party this lead is a view of, once it has been resolved to one.
   *
   * Optional because Discovery produces observations before anything decides
   * whether they are somebody the company already knows. A lead that carries a
   * handle is the same identity as the Client of that handle -- that is the
   * point of Party -- so converting one keeps its history instead of creating a
   * second record for the same business.
   *
   * Resolution is deliberately not automatic. See
   * `buzz_sdk::party_resolution`: more than one candidate is a decision for a
   * human, because a wrong automatic match fuses two customers' histories and
   * nothing downstream can tell that it happened.
   */
  partyHandle?: string;
};

export type LeadScope = {
  scope?: "campaign" | "global";
  /** Optional aliases make the adapter easy to bridge to route/search state. */
  kind?: "campaign" | "global";
  type?: "campaign" | "global";
  campaignId?: string;
  industryId?: string;
  verticalId?: string;
  targetType?: DiscoveryTargetType;
  fieldId?: string;
  roleId?: string;
  search?: string;
  status?: LeadFunnelStatus;
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

/** One Pipeline column: a bounded, status-filtered page plus the relay total. */
export type PipelineColumn = {
  status: LeadFunnelStatus;
  leads: Lead[];
  total: number;
};

export type LeadCountRow = {
  industryId: string;
  verticalId?: string;
  count: number;
};

export type LeadCounts = {
  total: number;
  industries: LeadCountRow[];
  verticals: LeadCountRow[];
};

export type OutreachChannel = "Email" | "LinkedIn" | "WhatsApp";
export type OutreachStatus = "Draft" | "Approved" | "Scheduled";

export type OutreachDraft = {
  id: string;
  campaignId: string;
  leadId: string;
  lead: string;
  company: string;
  channel: OutreachChannel;
  subject: string;
  body: string;
  status: OutreachStatus;
};

export type ConversationMessage = {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  sentAt: string;
};

export type ConversationThread = {
  id: string;
  campaignId: string;
  leadId: string;
  name: string;
  company: string;
  channel: "Email" | "WhatsApp";
  unread: boolean;
  messages: ConversationMessage[];
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
  requests?: number;
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
  | (SourceDiscoveryEvent & {
      type: "lead_duplicate";
      lead: Lead;
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
