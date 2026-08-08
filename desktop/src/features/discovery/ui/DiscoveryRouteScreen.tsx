import * as React from "react";

import type { DiscoverySearch } from "@/app/routes/discovery";
import { createFixtureDiscoveryDataSource } from "../data/FixtureDiscoveryDataSource";
import { createRelayDiscoveryDataSource } from "../data/RelayDiscoveryDataSource";
import type { DiscoveryDataSource } from "../data/DiscoveryDataSource";
import type { DiscoveryEntitlementState } from "../entitlement";
import type {
  CampaignDetail,
  LeadPage,
  ProfessionalRoleDetail,
  VerticalDetail,
} from "../types";
import {
  DiscoveryWorkspace,
  type DiscoveryRouteReadModel,
} from "./DiscoveryWorkspace";
import { LeadDetailDrawer } from "./LeadDetailDrawer";
import { DiscoveryTopTabs } from "./DiscoveryTopTabs";
import { DISCOVERY_LIGHT_SURFACE_STYLE } from "./discoverySurfaceStyle";
import { discoverySurface } from "./discoveryLayout";

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
  fields: [],
  roles: [],
  role: null,
  campaign: null,
  leads: null,
};

function routeNeedsVertical(search: DiscoverySearch) {
  return Boolean(search.industryId && search.verticalId);
}

function routeNeedsRole(search: DiscoverySearch) {
  return Boolean(search.fieldId && search.roleId);
}

function routeNeedsCampaign(search: DiscoverySearch) {
  return Boolean(search.campaignId);
}

function routeNeedsLeads(search: DiscoverySearch) {
  return (
    search.surface === "leads" ||
    search.tab === "leads" ||
    search.tab === "outreach" ||
    search.tab === "conversations"
  );
}

type DiscoveryE2eWindow = Window & {
  __BUZZ_E2E_DISCOVERY_ENTITLEMENT__?: DiscoveryEntitlementState;
  __BUZZ_E2E_DISCOVERY_EMPTY_LEADS__?: boolean;
  __BUZZ_E2E_DISCOVERY_UPDATE_LEAD_REJECT__?: string;
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

function fixtureUpdateLeadRejectOverride(): string | undefined {
  if (import.meta.env.MODE !== "e2e" || typeof window === "undefined") {
    return undefined;
  }
  return (window as DiscoveryE2eWindow)
    .__BUZZ_E2E_DISCOVERY_UPDATE_LEAD_REJECT__;
}

function fixtureEmptyLeadsOverride(): boolean | undefined {
  if (import.meta.env.MODE !== "e2e" || typeof window === "undefined") {
    return undefined;
  }
  return (window as DiscoveryE2eWindow).__BUZZ_E2E_DISCOVERY_EMPTY_LEADS__;
}

async function loadReadModel(
  dataSource: DiscoveryDataSource,
  search: DiscoverySearch,
): Promise<DiscoveryRouteReadModel> {
  const industries = await dataSource.getIndustries();
  const fields = await dataSource.getFields();
  const verticals = search.industryId
    ? await dataSource.getVerticals(search.industryId)
    : [];
  const roles = search.fieldId ? await dataSource.getRoles(search.fieldId) : [];
  let vertical: VerticalDetail | null = null;
  let role: ProfessionalRoleDetail | null = null;
  let campaign: CampaignDetail | null = null;
  let leads: LeadPage | null = null;

  if (routeNeedsVertical(search)) {
    vertical = await dataSource.getVertical(
      search.industryId as string,
      search.verticalId as string,
    );
  }

  if (routeNeedsRole(search)) {
    role = await dataSource.getRole(
      search.fieldId as string,
      search.roleId as string,
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
      targetType: search.campaignId
        ? search.entity === "people"
          ? "individual"
          : "business"
        : undefined,
      fieldId: search.fieldId,
      roleId: search.roleId,
      page: 1,
      pageSize: search.campaignId ? 100 : 500,
    });
  }

  return {
    industries,
    verticals,
    vertical,
    fields,
    roles,
    role,
    campaign,
    leads,
  };
}

export function DiscoveryRouteScreen({ search }: DiscoveryRouteScreenProps) {
  /**
   * The read model ignores `leadId`: opening or closing the drawer is a
   * navigation, and the surfaces behind it must not refetch or flash their
   * loading state because the drawer opened.
   */
  const readModelSearch = React.useMemo(() => {
    const { leadId: _leadId, ...rest } = search;
    return rest;
  }, [search]);
  const dataSourceRef = React.useRef<DiscoveryDataSource | null>(null);
  if (!dataSourceRef.current) {
    dataSourceRef.current =
      import.meta.env.MODE === "e2e"
        ? createFixtureDiscoveryDataSource({
            entitlement: fixtureEntitlementOverride(),
            emptyLeads: fixtureEmptyLeadsOverride(),
            updateLeadReject: fixtureUpdateLeadRejectOverride(),
          })
        : createRelayDiscoveryDataSource();
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
      loadReadModel(dataSource, readModelSearch),
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
  }, [dataSource, readModelSearch]);

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain bg-background text-foreground"
      style={DISCOVERY_LIGHT_SURFACE_STYLE}
    >
      <DiscoveryTopTabs
        showPipeline={
          state.entitlement?.experience === "live" ||
          (state.readModel?.leads?.total ?? 0) > 0
        }
        surface={discoverySurface(search)}
      />
      <DiscoveryWorkspace
        dataSource={dataSource}
        entitlement={state.entitlement}
        error={state.error}
        isLoading={state.isLoading}
        readModel={state.readModel}
        search={search}
      />
      <LeadDetailDrawer dataSource={dataSource} search={search} />
    </div>
  );
}
