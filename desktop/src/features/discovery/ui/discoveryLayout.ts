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

/** Search state for the field → role transition in People discovery. */
export function fieldRolesSearch(fieldId: string): DiscoveryNavigationOptions {
  return {
    entity: "people",
    surface: "verticals",
    fieldId,
  };
}

/** Search state for a role's individual discovery campaign list. */
export function roleCampaignsSearch(
  fieldId: string,
  roleId: string,
): DiscoveryNavigationOptions {
  return {
    entity: "people",
    surface: "campaigns",
    fieldId,
    roleId,
  };
}

/** Search state for an individual campaign detail surface. */
export function peopleCampaignDetailSearch(
  fieldId: string,
  roleId: string,
  campaignId: string,
): DiscoveryNavigationOptions {
  return {
    entity: "people",
    surface: "campaign",
    fieldId,
    roleId,
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
  if (search.roleId) return "campaigns";
  if (search.fieldId) return "verticals";
  return "industries";
}

/** The top-level Discovery tabs: Leads (default), Pipeline, and Discover. */
export type DiscoveryTopTab = "leads" | "pipeline" | "discover";

export function discoveryTopTab(
  surface: NonNullable<DiscoverySearch["surface"]>,
): DiscoveryTopTab {
  if (surface === "leads") return "leads";
  if (surface === "pipeline") return "pipeline";
  return "discover";
}

/** Stable descending sort by lead count, then name, for taxonomy grids. */
export function sortByLeadCountDesc<
  T extends { leadCount: number; name: string },
>(items: readonly T[]): T[] {
  return [...items].sort(
    (left, right) =>
      right.leadCount - left.leadCount || left.name.localeCompare(right.name),
  );
}

/** Infer the campaign tab for direct links that omit an explicit tab. */
export function campaignTabForSearch(
  search: DiscoverySearch,
): NonNullable<DiscoverySearch["tab"]> {
  if (search.tab) return search.tab;
  if (search.surface === "leads" && search.campaignId) return "leads";
  return "overview";
}

/** Keep transient search/filter state isolated to an addressable surface. */
export function discoveryFilterKey(search: DiscoverySearch): string {
  return [
    discoverySurface(search),
    search.industryId ?? "",
    search.verticalId ?? "",
    search.fieldId ?? "",
    search.roleId ?? "",
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

/** A People campaign list is addressable independently of campaign detail. */
export function isRoleCampaignListSearch(search: DiscoverySearch): boolean {
  return (
    search.entity === "people" &&
    discoverySurface(search) === "campaigns" &&
    Boolean(search.fieldId && search.roleId) &&
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
