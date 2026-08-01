import { createFileRoute } from "@tanstack/react-router";

import { DiscoveryRouteScreen } from "@/features/discovery/ui/DiscoveryRouteScreen";

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

export type DiscoverySearch = {
  surface?: DiscoverySurface;
  industryId?: string;
  verticalId?: string;
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
  return {
    surface: enumValue(search.surface, DISCOVERY_SURFACES),
    industryId: nonEmptyString(search.industryId),
    verticalId: nonEmptyString(search.verticalId),
    campaignId: nonEmptyString(search.campaignId),
    tab: enumValue(search.tab, DISCOVERY_TABS),
  };
}

export const Route = createFileRoute("/discovery")({
  validateSearch: validateDiscoverySearch,
  component: DiscoveryRouteComponent,
});

function DiscoveryRouteComponent() {
  return <DiscoveryRouteScreen search={Route.useSearch()} />;
}
