import * as React from "react";

import type { DiscoverySearch } from "@/app/routes/discovery";
import { createFixtureDiscoveryDataSource } from "../data/FixtureDiscoveryDataSource";
import type { DiscoveryDataSource } from "../data/DiscoveryDataSource";
import type { DiscoveryEntitlementState } from "../entitlement";
import type { CampaignDetail, LeadPage, VerticalDetail } from "../types";
import {
  DiscoveryWorkspace,
  type DiscoveryRouteReadModel,
} from "./DiscoveryWorkspace";

type DiscoveryRouteScreenProps = {
  search: DiscoverySearch;
};

type DiscoveryRouteState = {
  entitlement: Awaited<
    ReturnType<DiscoveryDataSource["getEntitlement"]>
  > | null;
  error: Error | null;
  isLoading: boolean;
  readModel: DiscoveryRouteReadModel | null;
};

const EMPTY_READ_MODEL: DiscoveryRouteReadModel = {
  industries: [],
  verticals: [],
  vertical: null,
  campaign: null,
  leads: null,
};

function routeNeedsVertical(search: DiscoverySearch) {
  return Boolean(search.industryId && search.verticalId);
}

function routeNeedsCampaign(search: DiscoverySearch) {
  return Boolean(search.campaignId);
}

function routeNeedsLeads(search: DiscoverySearch) {
  return search.surface === "leads" || search.tab === "leads";
}

type DiscoveryE2eWindow = Window & {
  __BUZZ_E2E_DISCOVERY_ENTITLEMENT__?: DiscoveryEntitlementState;
};

/**
 * The fixture route can be opened in a deterministic entitlement state for
 * browser proof. The hook is only read from an e2e build, so production
 * routing and entitlement reads cannot be influenced by a browser query.
 */
function fixtureEntitlementOverride(): DiscoveryEntitlementState | undefined {
  if (import.meta.env.MODE !== "e2e" || typeof window === "undefined") {
    return undefined;
  }
  return (window as DiscoveryE2eWindow).__BUZZ_E2E_DISCOVERY_ENTITLEMENT__;
}

async function loadReadModel(
  dataSource: DiscoveryDataSource,
  search: DiscoverySearch,
): Promise<DiscoveryRouteReadModel> {
  const industries = await dataSource.getIndustries();
  const verticals = search.industryId
    ? await dataSource.getVerticals(search.industryId)
    : [];
  let vertical: VerticalDetail | null = null;
  let campaign: CampaignDetail | null = null;
  let leads: LeadPage | null = null;

  if (routeNeedsVertical(search)) {
    vertical = await dataSource.getVertical(
      search.industryId as string,
      search.verticalId as string,
    );
  }

  if (routeNeedsCampaign(search)) {
    campaign = await dataSource.getCampaign(search.campaignId as string);
  }

  if (routeNeedsLeads(search)) {
    leads = await dataSource.getLeads({
      scope: search.campaignId ? "campaign" : "global",
      campaignId: search.campaignId,
      industryId: search.industryId,
      verticalId: search.verticalId,
      page: 1,
      pageSize: 25,
    });
  }

  return { industries, verticals, vertical, campaign, leads };
}

export function DiscoveryRouteScreen({ search }: DiscoveryRouteScreenProps) {
  const dataSourceRef = React.useRef<DiscoveryDataSource | null>(null);
  if (!dataSourceRef.current) {
    dataSourceRef.current = createFixtureDiscoveryDataSource({
      entitlement: fixtureEntitlementOverride(),
    });
  }
  const dataSource = dataSourceRef.current;
  const [state, setState] = React.useState<DiscoveryRouteState>(() => ({
    entitlement: null,
    error: null,
    isLoading: true,
    readModel: null,
  }));

  React.useEffect(() => {
    let cancelled = false;
    setState({
      entitlement: null,
      error: null,
      isLoading: true,
      readModel: null,
    });

    void Promise.all([
      dataSource.getEntitlement(),
      loadReadModel(dataSource, search),
    ])
      .then(([entitlement, readModel]) => {
        if (cancelled) return;
        setState({
          entitlement,
          error: null,
          isLoading: false,
          readModel,
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          entitlement: null,
          error: cause instanceof Error ? cause : new Error(String(cause)),
          isLoading: false,
          readModel: EMPTY_READ_MODEL,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [dataSource, search]);

  return (
    <DiscoveryWorkspace
      dataSource={dataSource}
      entitlement={state.entitlement}
      error={state.error}
      isLoading={state.isLoading}
      readModel={state.readModel}
      search={search}
    />
  );
}
