import type { DiscoverySearch } from "@/app/routes/discovery";
import type { DiscoveryNavigationOptions } from "@/app/navigation/useAppNavigation";
import type { CampaignSummary } from "../types";

export type DiscoveryFilterState = {
  query: string;
  statusFilter: "all" | "active" | "available";
};

export const EMPTY_DISCOVERY_FILTERS: DiscoveryFilterState = {
  query: "",
  statusFilter: "all",
};

/** Search state for the industry → vertical transition. */
export function industryVerticalSearch(
  industryId: string,
): DiscoveryNavigationOptions {
  return {
    surface: "verticals",
    industryId,
  };
}

/** Search state for a vertical's campaign list (no campaign is selected yet). */
export function verticalCampaignsSearch(
  industryId: string,
  verticalId: string,
): DiscoveryNavigationOptions {
  return {
    surface: "campaigns",
    industryId,
    verticalId,
  };
}

/** Search state for explicitly opening one campaign from the campaign list. */
export function campaignDetailSearch(
  industryId: string,
  verticalId: string,
  campaignId: string,
): DiscoveryNavigationOptions {
  return {
    surface: "campaign",
    industryId,
    verticalId,
    campaignId,
  };
}

export function discoverySurface(
  search: DiscoverySearch,
): NonNullable<DiscoverySearch["surface"]> {
  if (search.tab === "leads") return "leads";
  if (search.surface) return search.surface;
  if (search.campaignId) return "campaign";
  if (search.verticalId) return "campaigns";
  if (search.industryId) return "verticals";
  return "industries";
}

/** Keep transient search/filter state isolated to an addressable surface. */
export function discoveryFilterKey(search: DiscoverySearch): string {
  return [
    discoverySurface(search),
    search.industryId ?? "",
    search.verticalId ?? "",
    search.campaignId ?? "",
  ].join("/");
}

export function discoveryFiltersForSearch(
  filters: Readonly<Record<string, DiscoveryFilterState>>,
  search: DiscoverySearch,
): DiscoveryFilterState {
  return filters[discoveryFilterKey(search)] ?? EMPTY_DISCOVERY_FILTERS;
}

/** A campaign list is addressable independently of campaign detail. */
export function isCampaignListSearch(search: DiscoverySearch): boolean {
  return (
    discoverySurface(search) === "campaigns" &&
    Boolean(search.industryId && search.verticalId) &&
    !search.campaignId
  );
}

/** Return a safe, whole-number progress percentage for a campaign card. */
export function campaignProgressPercent(
  campaign: Pick<CampaignSummary, "leadCount" | "targetLeads">,
): number {
  const target = Number.isFinite(campaign.targetLeads)
    ? Math.max(0, campaign.targetLeads)
    : 0;
  if (target === 0) return 0;
  const leadCount = Number.isFinite(campaign.leadCount)
    ? Math.max(0, campaign.leadCount)
    : 0;
  return Math.min(100, Math.round((leadCount / target) * 100));
}
