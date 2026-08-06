import type { DiscoveryEntitlement } from "../entitlement";
import type {
  CampaignDetail,
  CampaignDraft,
  ConversationThread,
  DiscoveryEvent,
  Industry,
  LeadCounts,
  LeadPage,
  LeadScope,
  OutreachDraft,
  OutreachStatus,
  ProfessionalField,
  ProfessionalRole,
  ProfessionalRoleDetail,
  Vertical,
  VerticalDetail,
} from "../types";
import type { CampaignSourceConfig } from "../sourceConfig";

export interface DiscoveryDataSource {
  getEntitlement(): Promise<DiscoveryEntitlement>;
  getIndustries(): Promise<Industry[]>;
  getVerticals(industryId: string): Promise<Vertical[]>;
  getVertical(industryId: string, verticalId: string): Promise<VerticalDetail>;
  getFields(): Promise<ProfessionalField[]>;
  getRoles(fieldId: string): Promise<ProfessionalRole[]>;
  getRole(fieldId: string, roleId: string): Promise<ProfessionalRoleDetail>;
  getCampaign(campaignId: string): Promise<CampaignDetail>;
  getLeads(scope: LeadScope): Promise<LeadPage>;
  getLeadCounts(): Promise<LeadCounts>;
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
  updateSourceConfig(
    campaignId: string,
    config: CampaignSourceConfig,
  ): Promise<CampaignDetail>;
  startDiscovery(campaignId: string): AsyncIterable<DiscoveryEvent>;
  cancelDiscovery(campaignId: string): Promise<void>;
  retryDiscovery(campaignId: string): AsyncIterable<DiscoveryEvent>;
}
