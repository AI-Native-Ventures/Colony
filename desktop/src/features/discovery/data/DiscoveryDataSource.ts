import type { DiscoveryEntitlement } from "../entitlement";
import type {
  CampaignDetail,
  CampaignDraft,
  ConversationThread,
  DiscoveryEvent,
  Industry,
  LeadDetail,
  LeadCounts,
  LeadPage,
  PipelineColumn,
  LeadScope,
  LeadUpdateInput,
  OutreachDraft,
  OutreachStatus,
  ProfessionalField,
  ProfessionalRole,
  ProfessionalRoleDetail,
  Vertical,
  VerticalDetail,
} from "../types";

/** The mentionable Discovery entity kinds, in their wire spelling. */
export type DiscoveryEntityKind =
  | "industry"
  | "vertical"
  | "campaign"
  | "campaign_leads"
  | "lead"
  | "run";

/** One mention-directory row from `search_entities` (relay-shaped). */
export type DiscoveryEntitySummary = {
  kind: DiscoveryEntityKind;
  id: string;
  label: string;
  context_id?: string;
  detail?: string;
};

/** One structured reference carried by a `["discovery", kind, id]` tag. */
export type DiscoveryEntityRef = {
  kind: DiscoveryEntityKind;
  id: string;
};

/**
 * The relay caps one `resolve_entities` request at this many references, and
 * so does the mention tag budget of one message.
 */
export const DISCOVERY_RESOLVE_MAX_REFS = 20;

/**
 * The read models below mirror `buzz_core::discovery_workspace`'s
 * `ResolvedDiscoveryEntity` on the wire, snake_case included, so the relay
 * result needs no translation layer and the fixture source builds exactly the
 * same shape. Only the fields a tile renders are typed; the relay may send
 * more.
 */
export type ResolvedDiscoveryTaxonomy = {
  industry_id: string;
  industry_label: string;
  vertical_id?: string | null;
  vertical_label?: string | null;
  description?: string | null;
  lead_count: number;
};

/** Wire spelling of the Discovery funnel status. */
export type ResolvedDiscoveryLeadStatus =
  | "candidate"
  | "accepted"
  | "qualified"
  | "dormant"
  | "disqualified"
  | "client_active";

export type ResolvedDiscoveryLead = {
  lead_id: string;
  campaign_id: string;
  name: string;
  status: ResolvedDiscoveryLeadStatus;
  city?: string | null;
  website?: string | null;
  rating_hundredths?: number | null;
  reviews_count?: number | null;
};

export type ResolvedDiscoveryCampaign = {
  campaign_id: string;
  name: string;
  industry_name: string;
  vertical_name: string;
  location: string;
  lead_count: number;
  target: number;
};

export type ResolvedDiscoveryCollection = {
  campaign_id: string;
  total: number;
  leads: ResolvedDiscoveryLead[];
};

/** Wire spelling of the durable Discovery run lifecycle. */
export type ResolvedDiscoveryRunState =
  | "queued"
  | "running"
  | "succeeded"
  | "cancelled"
  | "failed";

export type ResolvedDiscoveryRun = {
  run_id: string;
  campaign_id: string;
  state: ResolvedDiscoveryRunState;
  completed_steps: number;
  total_steps: number;
};

export type ResolvedDiscoveryEntity =
  | { resolved: "industry"; taxonomy: ResolvedDiscoveryTaxonomy }
  | { resolved: "vertical"; taxonomy: ResolvedDiscoveryTaxonomy }
  | { resolved: "campaign"; campaign: ResolvedDiscoveryCampaign }
  | { resolved: "campaign_leads"; collection: ResolvedDiscoveryCollection }
  | { resolved: "lead"; lead: ResolvedDiscoveryLead }
  | { resolved: "run"; run: ResolvedDiscoveryRun }
  | { resolved: "unavailable"; kind: DiscoveryEntityKind; id: string };

export interface DiscoveryDataSource {
  getEntitlement(): Promise<DiscoveryEntitlement>;
  searchEntities?(
    query: string,
    limit?: number,
  ): Promise<DiscoveryEntitySummary[]>;
  /**
   * Resolve mention references into current, permission-checked context, in
   * request order. A reference that is forged, deleted, out of community or
   * not visible to this reader resolves to `unavailable` rather than failing.
   */
  resolveEntities?(
    refs: readonly DiscoveryEntityRef[],
  ): Promise<ResolvedDiscoveryEntity[]>;
  getIndustries(): Promise<Industry[]>;
  getVerticals(industryId: string): Promise<Vertical[]>;
  getVertical(industryId: string, verticalId: string): Promise<VerticalDetail>;
  getFields(): Promise<ProfessionalField[]>;
  getRoles(fieldId: string): Promise<ProfessionalRole[]>;
  getRole(fieldId: string, roleId: string): Promise<ProfessionalRoleDetail>;
  getCampaign(campaignId: string): Promise<CampaignDetail>;
  getLeads(scope: LeadScope): Promise<LeadPage>;
  getPipelineColumns(): Promise<PipelineColumn[]>;
  getLeadCounts(): Promise<LeadCounts>;
  getLead(leadId: string): Promise<LeadDetail>;
  updateLead(leadId: string, input: LeadUpdateInput): Promise<LeadDetail>;
  getOutreach(campaignId: string): Promise<OutreachDraft[]>;
  createOutreach(campaignId: string): Promise<OutreachDraft>;
  updateOutreachStatus(
    campaignId: string,
    outreachId: string,
    status: OutreachStatus,
  ): Promise<OutreachDraft>;
  getConversations(campaignId: string): Promise<ConversationThread[]>;
  markConversationRead(
    campaignId: string,
    conversationId: string,
  ): Promise<ConversationThread>;
  sendConversationReply(
    campaignId: string,
    conversationId: string,
    body: string,
  ): Promise<ConversationThread>;
  createCampaign(input: CampaignDraft): Promise<CampaignDetail>;
  approveCampaignBudget(campaignId: string): Promise<CampaignDetail>;
  pauseCampaignBudget(campaignId: string): Promise<CampaignDetail>;
  revokeCampaignBudget(campaignId: string): Promise<CampaignDetail>;
  startDiscovery(campaignId: string): AsyncIterable<DiscoveryEvent>;
  cancelDiscovery(campaignId: string): Promise<void>;
  retryDiscovery(campaignId: string): AsyncIterable<DiscoveryEvent>;
}
