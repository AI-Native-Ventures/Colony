import * as React from "react";
import { LockKeyhole, RefreshCw } from "lucide-react";

import type { DiscoverySearch } from "@/app/routes/discovery";
import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { canStartDiscovery, type DiscoveryEntitlement } from "../entitlement";
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
import { CreateCampaignSheet } from "./CreateCampaignSheet";
import { DiscoveryHeader, type DiscoveryMode } from "./DiscoveryHeader";
import { EntitlementLock } from "./EntitlementLock";
import { IndustryAudienceHint, IndustryGrid } from "./IndustryGrid";
import { MetricCard } from "./MetricCard";
import { SourceConfigEditor } from "./SourceConfigEditor";
import { VerticalGrid } from "./VerticalGrid";

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

function CampaignControls({
  campaign,
  dataSource,
  entitlement,
  onRun,
  onUpdated,
  runNotice,
}: {
  campaign: CampaignDetail;
  dataSource: DiscoveryDataSource;
  entitlement: DiscoveryEntitlement | null;
  onRun: () => void;
  onUpdated: (campaign: CampaignDetail) => void;
  runNotice: string | null;
}) {
  return (
    <Card className="space-y-4 border-border/60 bg-card/70 p-4 shadow-none">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-2xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
            Campaign actions
          </p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">
            {campaign.name}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure sources before starting a discovery run. The detailed
            campaign tabs will follow in the next surface.
          </p>
        </div>
        <EntitlementLock
          entitlement={entitlement}
          onRetry={() => window.location.reload()}
          onRun={onRun}
        />
      </div>
      {runNotice ? (
        <p
          className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-primary"
          role="status"
        >
          {runNotice}
        </p>
      ) : null}
      <SourceConfigEditor
        campaign={campaign}
        dataSource={dataSource}
        entitlement={entitlement}
        onUpdated={onUpdated}
      />
    </Card>
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
  const [campaignOverride, setCampaignOverride] =
    React.useState<CampaignDetail | null>(null);
  const [runNotice, setRunNotice] = React.useState<string | null>(null);
  const campaignId = search.campaignId;
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

  React.useEffect(() => {
    if (campaignId === undefined) return;
    setCampaignOverride(null);
    setRunNotice(null);
  }, [campaignId]);

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

  if (mode === "people") {
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

  if (surface === "campaigns" || surface === "campaign") {
    if (!vertical) {
      return (
        <WorkspaceState
          description="Choose a vertical before opening its campaign workspace."
          title="Campaign list unavailable"
        />
      );
    }

    const selectedCampaign =
      surface === "campaign" ? (campaignOverride ?? readModel.campaign) : null;
    const runDiscovery = () => {
      if (!selectedCampaign) return;
      if (!canStartDiscovery({ state: entitlement?.state ?? "loading" })) {
        setRunNotice(
          entitlement?.state === "error"
            ? "Discovery access could not be confirmed. Retry access before running."
            : "Activate LAKA before running discovery.",
        );
        return;
      }
      setRunNotice("Discovery is running with the configured sources…");
      void (async () => {
        try {
          let terminal = "Discovery completed";
          for await (const event of dataSource.startDiscovery(
            selectedCampaign.id,
          )) {
            if (event.type === "session_failed") terminal = event.error;
            if (event.type === "session_cancelled")
              terminal = "Discovery was cancelled";
            if (event.type === "session_completed") {
              terminal = event.partial
                ? "Discovery completed with partial results"
                : "Discovery completed";
            }
          }
          setRunNotice(terminal);
        } catch (cause: unknown) {
          setRunNotice(
            cause instanceof Error
              ? cause.message
              : "Discovery could not start",
          );
        }
      })();
    };

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
          selectedCampaign={selectedCampaign}
          vertical={vertical}
        />
        {selectedCampaign ? (
          <CampaignControls
            campaign={selectedCampaign}
            dataSource={dataSource}
            entitlement={entitlement}
            onRun={runDiscovery}
            onUpdated={setCampaignOverride}
            runNotice={runNotice}
          />
        ) : null}
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
      <div className="space-y-5">
        <DiscoveryHeader
          breadcrumb={industry?.name}
          description="Lead tables will connect campaign results to the next action."
          onBack={() =>
            void goDiscovery(
              search.verticalId && search.industryId
                ? verticalCampaignsSearch(search.industryId, search.verticalId)
                : { surface: "industries" },
            )
          }
          title="Leads"
        />
        <WorkspaceState
          description="The campaign and global lead tables arrive in the next Discovery surface."
          title="Leads are coming soon"
        />
      </div>
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
