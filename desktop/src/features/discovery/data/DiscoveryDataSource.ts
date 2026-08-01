import type { DiscoveryEntitlement } from "../entitlement";
import type {
  CampaignDetail,
  CampaignDraft,
  DiscoveryEvent,
  Industry,
  LeadPage,
  LeadScope,
  VerticalDetail,
} from "../types";
import type { CampaignSourceConfig } from "../sourceConfig";

export interface DiscoveryDataSource {
  getEntitlement(): Promise<DiscoveryEntitlement>;
  getIndustries(): Promise<Industry[]>;
  getVertical(industryId: string, verticalId: string): Promise<VerticalDetail>;
  getCampaign(campaignId: string): Promise<CampaignDetail>;
  getLeads(scope: LeadScope): Promise<LeadPage>;
  createCampaign(input: CampaignDraft): Promise<CampaignDetail>;
  updateSourceConfig(
    campaignId: string,
    config: CampaignSourceConfig,
  ): Promise<CampaignDetail>;
  startDiscovery(campaignId: string): AsyncIterable<DiscoveryEvent>;
  cancelDiscovery(campaignId: string): Promise<void>;
  retryDiscovery(campaignId: string): AsyncIterable<DiscoveryEvent>;
}
