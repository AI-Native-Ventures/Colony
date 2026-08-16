import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { DiscoverySearch } from "@/app/routes/discovery";
import { createFixtureDiscoveryDataSource } from "../data/FixtureDiscoveryDataSource";
import { createRelayDiscoveryDataSource } from "../data/RelayDiscoveryDataSource";
import type { DiscoveryDataSource } from "../data/DiscoveryDataSource";
import { withWriteInvalidation } from "../data/writeInvalidation";
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
import { discoverySurface, showPipelineTab } from "./discoveryLayout";

type DiscoveryRouteScreenProps = {
  search: DiscoverySearch;
};

/**
 * The React Query namespace for Discovery reads.
 *
 * `CommunityQueryProvider` builds a fresh client per community, so these keys
 * are already community-scoped and must not be reused outside that provider.
 */
const DISCOVERY_QUERY_ROOT = "colony-discovery" as const;

/**
 * How long a loaded surface is served from cache before it is read again.
 *
 * Long enough that moving between Leads, Pipeline and Discover is instant,
 * short enough that a campaign run's new leads appear without a reload.
 */
const DISCOVERY_STALE_TIME_MS = 30_000;

/** The addressable identity of a read model: every input `loadReadModel` reads. */
function readModelQueryKey(search: DiscoverySearch) {
  return [
    DISCOVERY_QUERY_ROOT,
    "read-model",
    search.entity ?? null,
    search.surface ?? null,
    search.industryId ?? null,
    search.verticalId ?? null,
    search.fieldId ?? null,
    search.roleId ?? null,
    search.campaignId ?? null,
    search.tab ?? null,
  ] as const;
}

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

/**
 * Every read the active surface needs, issued concurrently.
 *
 * These eight reads do not depend on each other: each one is decided by the
 * search alone. Awaiting them in sequence cost one relay round trip per read
 * before the screen could paint, which is most of what made switching tabs
 * take seconds.
 */
async function loadReadModel(
  dataSource: DiscoveryDataSource,
  search: DiscoverySearch,
): Promise<DiscoveryRouteReadModel> {
  const [
    industries,
    fields,
    verticals,
    roles,
    vertical,
    role,
    campaign,
    leads,
  ] = await Promise.all([
    dataSource.getIndustries(),
    dataSource.getFields(),
    search.industryId
      ? dataSource.getVerticals(search.industryId)
      : Promise.resolve([]),
    search.fieldId ? dataSource.getRoles(search.fieldId) : Promise.resolve([]),
    routeNeedsVertical(search)
      ? dataSource.getVertical(
          search.industryId as string,
          search.verticalId as string,
        )
      : Promise.resolve<VerticalDetail | null>(null),
    routeNeedsRole(search)
      ? dataSource.getRole(search.fieldId as string, search.roleId as string)
      : Promise.resolve<ProfessionalRoleDetail | null>(null),
    routeNeedsCampaign(search)
      ? dataSource.getCampaign(search.campaignId as string)
      : Promise.resolve<CampaignDetail | null>(null),
    routeNeedsLeads(search)
      ? dataSource.getLeads({
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
        })
      : Promise.resolve<LeadPage | null>(null),
  ]);

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
  const queryClient = useQueryClient();
  /**
   * Reads are cached, so a write has to say so. Without this a surface
   * revisited after editing a lead or a campaign's sources would render the
   * answer from before the edit.
   */
  const dataSource = React.useMemo(
    () =>
      withWriteInvalidation(
        dataSourceRef.current as DiscoveryDataSource,
        () => {
          void queryClient.invalidateQueries({
            queryKey: [DISCOVERY_QUERY_ROOT],
          });
        },
      ),
    [queryClient],
  );

  const entitlementQuery = useQuery({
    queryKey: [DISCOVERY_QUERY_ROOT, "entitlement"],
    queryFn: () => dataSource.getEntitlement(),
    staleTime: DISCOVERY_STALE_TIME_MS,
  });

  const readModelQuery = useQuery({
    queryKey: readModelQueryKey(readModelSearch),
    queryFn: () => loadReadModel(dataSource, readModelSearch),
    staleTime: DISCOVERY_STALE_TIME_MS,
  });

  /**
   * A surface already visited renders from cache with no request and no
   * skeleton, which is what makes switching tabs feel instant. Only a surface
   * with nothing cached shows the loading state.
   */
  const error = readModelQuery.error ?? entitlementQuery.error;
  const readModel = error
    ? EMPTY_READ_MODEL
    : (readModelQuery.data ?? EMPTY_READ_MODEL);
  const isLoading =
    !error && (readModelQuery.isPending || entitlementQuery.isPending);

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain bg-background text-foreground"
      style={DISCOVERY_LIGHT_SURFACE_STYLE}
    >
      <DiscoveryTopTabs
        showPipeline={showPipelineTab({
          experience: entitlementQuery.data?.experience,
          leadTotal: readModel.leads?.total ?? 0,
          surface: discoverySurface(search),
        })}
        surface={discoverySurface(search)}
      />
      <DiscoveryWorkspace
        dataSource={dataSource}
        entitlement={entitlementQuery.data ?? null}
        error={error instanceof Error ? error : (error ?? null)}
        isLoading={isLoading}
        readModel={isLoading ? null : readModel}
        search={search}
      />
      <LeadDetailDrawer dataSource={dataSource} search={search} />
    </div>
  );
}
