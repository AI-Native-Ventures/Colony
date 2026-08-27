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

/** One mention-directory row from `search_entities` (relay-shaped). */
export type DiscoveryEntitySummary = {
  kind:
    | "industry"
    | "vertical"
    | "campaign"
    | "campaign_leads"
    | "lead"
    | "run";
  id: string;
  label: string;
  context_id?: string;
  detail?: string;
};

export interface DiscoveryDataSource {
  getEntitlement(): Promise<DiscoveryEntitlement>;
  searchEntities?(
    query: string,
    limit?: number,
  ): Promise<DiscoveryEntitySummary[]>;
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
