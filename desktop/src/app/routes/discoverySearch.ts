export type DiscoverySurface =
  | "industries"
  | "verticals"
  | "campaigns"
  | "campaign"
  | "leads";

export type DiscoveryTab =
  | "overview"
  | "discovery"
  | "leads"
  | "outreach"
  | "conversations"
  | "settings";

export type DiscoveryEntity = "businesses" | "people";

export type DiscoverySearch = {
  entity?: DiscoveryEntity;
  surface?: DiscoverySurface;
  industryId?: string;
  verticalId?: string;
  fieldId?: string;
  roleId?: string;
  campaignId?: string;
  tab?: DiscoveryTab;
};

const DISCOVERY_SURFACES: readonly DiscoverySurface[] = [
  "industries",
  "verticals",
  "campaigns",
  "campaign",
  "leads",
];

const DISCOVERY_TABS: readonly DiscoveryTab[] = [
  "overview",
  "discovery",
  "leads",
  "outreach",
  "conversations",
  "settings",
];

const DISCOVERY_ENTITIES: readonly DiscoveryEntity[] = ["businesses", "people"];

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
): T | undefined {
  return typeof value === "string" && values.includes(value as T)
    ? (value as T)
    : undefined;
}

/** Validate and narrow untrusted URL search state at the router boundary. */
export function validateDiscoverySearch(
  search: Record<string, unknown>,
): DiscoverySearch {
  const hasContext = Boolean(
    search.industryId ||
      search.verticalId ||
      search.fieldId ||
      search.roleId ||
      search.campaignId,
  );
  return {
    entity: enumValue(search.entity, DISCOVERY_ENTITIES),
    surface:
      enumValue(search.surface, DISCOVERY_SURFACES) ??
      (hasContext ? undefined : "leads"),
    industryId: nonEmptyString(search.industryId),
    verticalId: nonEmptyString(search.verticalId),
    fieldId: nonEmptyString(search.fieldId),
    roleId: nonEmptyString(search.roleId),
    campaignId: nonEmptyString(search.campaignId),
    tab: enumValue(search.tab, DISCOVERY_TABS),
  };
}
