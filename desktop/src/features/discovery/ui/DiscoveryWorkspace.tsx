import * as React from "react";
import { LockKeyhole, RefreshCw } from "lucide-react";

import type { DiscoverySearch } from "@/app/routes/discovery";
import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import type { DiscoveryEntitlement } from "../entitlement";
import type { DiscoveryDataSource } from "../data/DiscoveryDataSource";
import type {
  CampaignDetail,
  Industry,
  LeadPage,
  Vertical,
  VerticalDetail,
} from "../types";
import {
  campaignDetailSearch,
  discoveryFilterKey,
  discoveryFiltersForSearch,
  type DiscoveryFilterState,
  discoverySurface,
  EMPTY_DISCOVERY_FILTERS,
  industryVerticalSearch,
  verticalCampaignsSearch,
} from "./discoveryLayout";
import { CampaignListView } from "./CampaignListView";
import { CampaignDetailView } from "./CampaignDetailView";
import { CreateCampaignSheet } from "./CreateCampaignSheet";
import { DiscoveryHeader, type DiscoveryMode } from "./DiscoveryHeader";
import { IndustryAudienceHint, IndustryGrid } from "./IndustryGrid";
import { MetricCard } from "./MetricCard";
import { VerticalGrid } from "./VerticalGrid";
import { LeadsWorkspace } from "./LeadsWorkspace";

/** The read models loaded by the route for the active addressable surface. */
export type DiscoveryRouteReadModel = {
  industries: Industry[];
  verticals: Vertical[];
  vertical: VerticalDetail | null;
  campaign: CampaignDetail | null;
  leads: LeadPage | null;
};

export type DiscoveryWorkspaceProps = {
  dataSource: DiscoveryDataSource;
  entitlement: DiscoveryEntitlement | null;
  error: Error | null;
  isLoading: boolean;
  readModel: DiscoveryRouteReadModel | null;
  search: DiscoverySearch;
};

function WorkspaceState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <Card className="border-border/60 bg-card/70 p-10 text-center shadow-none">
      {icon ?? <RefreshCw className="mx-auto h-8 w-8 text-muted-foreground" />}
      <h2 className="mt-3 text-lg font-semibold text-foreground">{title}</h2>
      <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
        {description}
      </p>
      {action ? <div className="mt-4">{action}</div> : null}
    </Card>
  );
}

function LoadingState() {
  const skeletons = ["first", "second", "third"];
  return (
    <div aria-busy="true" className="space-y-5">
      <div className="h-24 animate-pulse rounded-xl bg-muted/40" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {skeletons.map((skeleton) => (
          <div
            className="h-72 animate-pulse rounded-xl bg-muted/35"
            key={skeleton}
          />
        ))}
      </div>
      <span className="sr-only">Loading discovery surfaces</span>
    </div>
  );
}

function PeopleSoonState() {
  return (
    <WorkspaceState
      description="People discovery will layer contact discovery onto the same industry and vertical map. We are keeping this surface locked until the provider contract is ready."
      icon={<LockKeyhole className="mx-auto h-8 w-8 text-muted-foreground" />}
      title="People discovery is coming soon"
    />
  );
}

function entitlementMessage(entitlement: DiscoveryEntitlement | null) {
  if (!entitlement || entitlement.state === "entitled") return null;
  if (entitlement.state === "loading") return "Checking Discovery access";
  if (entitlement.state === "not_entitled") {
    return entitlement.planName
      ? `Discovery is available on ${entitlement.planName}`
      : "Discovery access is not enabled for this workspace";
  }
  return "Discovery access could not be confirmed";
}

function EntitlementNotice({
  entitlement,
}: {
  entitlement: DiscoveryEntitlement | null;
}) {
  const message = entitlementMessage(entitlement);
  if (!message) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
      <p>
        <Badge className="mr-2" variant="warning">
          Access
        </Badge>
        {message}
      </p>
      {entitlement?.state === "error" ? (
        <Button
          onClick={() => window.location.reload()}
          size="sm"
          type="button"
          variant="outline"
        >
          Retry access
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Colony's first Discovery workspace: industries, verticals, and campaigns.
 * The route owns reads; this component owns presentation and addressable hops.
 */
export function DiscoveryWorkspace({
  dataSource,
  entitlement,
  error,
  isLoading,
  readModel,
  search,
}: DiscoveryWorkspaceProps) {
  const { goDiscovery } = useAppNavigation();
  const [mode, setMode] = React.useState<DiscoveryMode>("businesses");
  const [filters, setFilters] = React.useState<
    Record<string, DiscoveryFilterState>
  >({});
  const [createCampaignOpen, setCreateCampaignOpen] = React.useState(false);
  const surface = discoverySurface(search);
  const surfaceFilter = discoveryFiltersForSearch(filters, search);
  const query = surfaceFilter.query;
  const statusFilter = surfaceFilter.statusFilter;
  const filterKey = discoveryFilterKey(search);
  const updateFilters = React.useCallback(
    (next: Partial<DiscoveryFilterState>) => {
      setFilters((current) => ({
        ...current,
        [filterKey]: {
          ...(current[filterKey] ?? EMPTY_DISCOVERY_FILTERS),
          ...next,
        },
      }));
    },
    [filterKey],
  );

  if (isLoading || !readModel) {
    return <LoadingState />;
  }

  if (error) {
    return (
      <WorkspaceState
        action={
          <Button onClick={() => window.location.reload()} variant="outline">
            Reload discovery
          </Button>
        }
        description={error.message}
        title="Discovery could not load"
      />
    );
  }

  const industry = readModel.industries.find(
    (candidate) => candidate.id === search.industryId,
  );
  const vertical = readModel.vertical;

  if (mode === "people" && surface !== "leads") {
    return (
      <div className="space-y-5">
        <DiscoveryHeader
          description="Choose an industry and vertical to find the right businesses for your next campaign."
          mode={mode}
          onModeChange={setMode}
          title="Discover people"
        />
        <PeopleSoonState />
      </div>
    );
  }

  if ((surface === "campaign" || surface === "leads") && search.campaignId) {
    if (!readModel.campaign) {
      return (
        <WorkspaceState
          description="Choose a campaign from its vertical before opening details."
          title="Campaign unavailable"
        />
      );
    }
    return (
      <CampaignDetailView
        campaign={readModel.campaign}
        dataSource={dataSource}
        entitlement={entitlement}
        leads={readModel.leads}
        onBack={() =>
          void goDiscovery(
            verticalCampaignsSearch(
              readModel.campaign?.industryId ?? search.industryId ?? "",
              readModel.campaign?.verticalId ?? search.verticalId ?? "",
            ),
          )
        }
        onTabChange={(tab) =>
          void goDiscovery({
            campaignId: readModel.campaign?.id ?? search.campaignId,
            industryId: readModel.campaign?.industryId ?? search.industryId,
            verticalId: readModel.campaign?.verticalId ?? search.verticalId,
            surface: tab === "leads" ? "leads" : "campaign",
            tab,
          })
        }
        search={search}
      />
    );
  }

  if (surface === "campaigns") {
    if (!vertical) {
      return (
        <WorkspaceState
          description="Choose a vertical before opening its campaign workspace."
          title="Campaign list unavailable"
        />
      );
    }

    return (
      <div className="space-y-4">
        <div className="flex justify-end">
          <Button onClick={() => setCreateCampaignOpen(true)} type="button">
            Create campaign
          </Button>
        </div>
        <EntitlementNotice entitlement={entitlement} />
        <CampaignListView
          campaigns={vertical.campaigns}
          onBack={() =>
            void goDiscovery(industryVerticalSearch(vertical.industryId))
          }
          onOpenCampaign={(campaign) =>
            void goDiscovery(
              campaignDetailSearch(
                campaign.industryId,
                campaign.verticalId,
                campaign.id,
              ),
            )
          }
          vertical={vertical}
        />
        <CreateCampaignSheet
          dataSource={dataSource}
          entitlement={entitlement}
          industryName={industry?.name ?? vertical.industryId}
          onCreated={(campaign) => {
            setCreateCampaignOpen(false);
            void goDiscovery(
              campaignDetailSearch(
                campaign.industryId,
                campaign.verticalId,
                campaign.id,
              ),
            );
          }}
          onOpenChange={setCreateCampaignOpen}
          onRetryEntitlement={() => window.location.reload()}
          open={createCampaignOpen}
          vertical={vertical}
        />
      </div>
    );
  }

  if (surface === "verticals") {
    if (!industry) {
      return (
        <WorkspaceState
          description="This industry is no longer available in the Discovery catalog."
          title="Industry not found"
        />
      );
    }
    const verticals = readModel.verticals.filter(
      (candidate) =>
        statusFilter === "all" || candidate.status === statusFilter,
    );
    const normalizedQuery = query.trim().toLowerCase();
    const visibleVerticals = normalizedQuery
      ? verticals.filter((candidate) =>
          [candidate.name, candidate.description]
            .filter(Boolean)
            .some((value) => value?.toLowerCase().includes(normalizedQuery)),
        )
      : verticals;

    return (
      <div className="space-y-5">
        <DiscoveryHeader
          breadcrumb={industry.name}
          description="Choose a vertical to see its campaigns and discovery history."
          mode={mode}
          onBack={() => void goDiscovery({ surface: "industries" })}
          onModeChange={setMode}
          onQueryChange={(nextQuery) => updateFilters({ query: nextQuery })}
          onStatusFilterChange={(nextStatus) =>
            updateFilters({ statusFilter: nextStatus })
          }
          query={query}
          showToolbar
          statusFilter={statusFilter}
          title="Choose a vertical"
          toolbarEntity="verticals"
        />
        <EntitlementNotice entitlement={entitlement} />
        <VerticalGrid
          industryName={industry.name}
          onSelect={(selectedVertical) =>
            void goDiscovery(
              verticalCampaignsSearch(industry.id, selectedVertical.id),
            )
          }
          verticals={visibleVerticals}
        />
      </div>
    );
  }

  if (surface === "leads") {
    return (
      <LeadsWorkspace
        dataSource={dataSource}
        initialLeads={readModel.leads}
        scope="global"
      />
    );
  }

  const normalizedQuery = query.trim().toLowerCase();
  const visibleIndustries = readModel.industries
    .filter(
      (candidate) =>
        statusFilter === "all" || candidate.status === statusFilter,
    )
    .filter((candidate) => {
      if (!normalizedQuery) return true;
      return [candidate.name, candidate.description]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalizedQuery));
    });

  return (
    <div className="space-y-5">
      <DiscoveryHeader
        description="Start with an industry, then narrow to a vertical before choosing a campaign."
        mode={mode}
        onModeChange={setMode}
        onQueryChange={(nextQuery) => updateFilters({ query: nextQuery })}
        onStatusFilterChange={(nextStatus) =>
          updateFilters({ statusFilter: nextStatus })
        }
        query={query}
        showToolbar
        statusFilter={statusFilter}
        title="Discover businesses"
        toolbarEntity="industries"
      />
      <EntitlementNotice entitlement={entitlement} />
      <IndustryAudienceHint />
      <IndustryGrid
        industries={visibleIndustries}
        onSelect={(industryToOpen) =>
          void goDiscovery(industryVerticalSearch(industryToOpen.id))
        }
      />
      <div className="grid max-w-xl grid-cols-2 gap-3">
        <MetricCard label="Industries" value={visibleIndustries.length} />
        <MetricCard
          hint="Across the catalog"
          label="Available campaigns"
          value={readModel.industries.reduce(
            (total, candidate) => total + candidate.campaignCount,
            0,
          )}
        />
      </div>
    </div>
  );
}
