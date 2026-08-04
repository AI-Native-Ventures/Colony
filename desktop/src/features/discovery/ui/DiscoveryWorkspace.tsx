import * as React from "react";
import { RefreshCw } from "lucide-react";

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
  ProfessionalField,
  ProfessionalRole,
  ProfessionalRoleDetail,
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
  fieldRolesSearch,
  industryVerticalSearch,
  peopleCampaignDetailSearch,
  roleCampaignsSearch,
  verticalCampaignsSearch,
} from "./discoveryLayout";
import { CampaignListView } from "./CampaignListView";
import { CampaignDetailView } from "./CampaignDetailView";
import { CreateCampaignSheet } from "./CreateCampaignSheet";
import { CreatePeopleCampaignSheet } from "./CreatePeopleCampaignSheet";
import { DiscoveryHeader, type DiscoveryMode } from "./DiscoveryHeader";
import { IndustryGrid } from "./IndustryGrid";
import { DiscoveryListFilters } from "./DiscoveryListFilters";
import { VerticalGrid } from "./VerticalGrid";
import { LeadsWorkspace } from "./LeadsWorkspace";
import { FieldGrid } from "./FieldGrid";
import { RoleGrid } from "./RoleGrid";
import { RoleCampaignListView } from "./RoleCampaignListView";

/** The read models loaded by the route for the active addressable surface. */
export type DiscoveryRouteReadModel = {
  industries: Industry[];
  verticals: Vertical[];
  vertical: VerticalDetail | null;
  fields: ProfessionalField[];
  roles: ProfessionalRole[];
  role: ProfessionalRoleDetail | null;
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

function entitlementMessage(entitlement: DiscoveryEntitlement | null) {
  if (!entitlement || entitlement.state === "entitled") return null;
  if (entitlement.state === "loading") return "Checking Discovery access";
  if (entitlement.state === "not_entitled") {
    return "Discovery access is not enabled for this workspace";
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
  const mode: DiscoveryMode =
    search.entity === "people" ? "people" : "businesses";
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
  const changeMode = React.useCallback(
    (nextMode: DiscoveryMode) => {
      void goDiscovery({
        entity: nextMode,
        surface: "industries",
      });
    },
    [goDiscovery],
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

  if (mode === "people" && entitlement?.experience === "live") {
    return (
      <div className="px-9 pb-16 pt-9">
        <WorkspaceState
          description="The first production phase focuses on finding businesses and retaining them automatically as Leads. People discovery will follow after that path is proven."
          title="People discovery is preview-only for now"
        />
      </div>
    );
  }

  const industry = readModel.industries.find(
    (candidate) => candidate.id === search.industryId,
  );
  const vertical = readModel.vertical;
  const field = readModel.fields.find(
    (candidate) => candidate.id === search.fieldId,
  );
  const role = readModel.role;

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
        onBack={() => {
          const campaign = readModel.campaign;
          if (campaign?.targetType === "individual") {
            void goDiscovery(
              roleCampaignsSearch(
                campaign.fieldId ?? campaign.industryId,
                campaign.roleId ?? campaign.verticalId,
              ),
            );
            return;
          }
          void goDiscovery(
            verticalCampaignsSearch(
              campaign?.industryId ?? search.industryId ?? "",
              campaign?.verticalId ?? search.verticalId ?? "",
            ),
          );
        }}
        onTabChange={(tab) =>
          void goDiscovery(
            readModel.campaign?.targetType === "individual"
              ? {
                  ...peopleCampaignDetailSearch(
                    readModel.campaign.fieldId ?? readModel.campaign.industryId,
                    readModel.campaign.roleId ?? readModel.campaign.verticalId,
                    readModel.campaign.id,
                  ),
                  surface: tab === "leads" ? "leads" : "campaign",
                  tab,
                }
              : {
                  campaignId: readModel.campaign?.id ?? search.campaignId,
                  industryId:
                    readModel.campaign?.industryId ?? search.industryId,
                  verticalId:
                    readModel.campaign?.verticalId ?? search.verticalId,
                  surface: tab === "leads" ? "leads" : "campaign",
                  tab,
                },
          )
        }
        search={search}
      />
    );
  }

  if (mode === "people" && surface === "campaigns") {
    if (!role || !field) {
      return (
        <WorkspaceState
          description="Choose a professional role before opening its campaign workspace."
          title="Campaign list unavailable"
        />
      );
    }
    const normalizedQuery = query.trim().toLowerCase();
    const visibleRoles = readModel.roles.filter((candidate) => {
      if (statusFilter !== "all" && candidate.status !== statusFilter) {
        return false;
      }
      if (!normalizedQuery) return true;
      return [candidate.name, candidate.description]
        .filter(Boolean)
        .some((value) => value?.toLowerCase().includes(normalizedQuery));
    });
    return (
      <div className="relative space-y-6 px-9 pb-16 pt-9">
        <DiscoveryHeader
          breadcrumb="Fields"
          description={`${visibleRoles.length} Roles Available`}
          mode={mode}
          onBack={() =>
            void goDiscovery({ entity: "people", surface: "industries" })
          }
          onModeChange={changeMode}
          onQueryChange={(nextQuery) => updateFilters({ query: nextQuery })}
          query={query}
          showToolbar
          title={field.displayName ?? field.name}
          toolbarEntity="roles"
        />
        <DiscoveryListFilters
          entity="Fields"
          onFilterChange={() => undefined}
          onViewModeChange={() => undefined}
          selectedFilter="All Fields"
          showFilters={false}
          total={visibleRoles.length}
          viewMode="grid"
        />
        <RoleGrid
          fieldName={field.name}
          roles={visibleRoles}
          onSelect={(selectedRole) =>
            void goDiscovery(roleCampaignsSearch(field.id, selectedRole.id))
          }
        />
        <EntitlementNotice entitlement={entitlement} />
        <RoleCampaignListView
          campaigns={role.campaigns}
          fieldName={field.name}
          onBack={() => void goDiscovery(fieldRolesSearch(field.id))}
          onCreateCampaign={() => setCreateCampaignOpen(true)}
          onOpenCampaign={(campaign) =>
            void goDiscovery(
              peopleCampaignDetailSearch(field.id, role.id, campaign.id),
            )
          }
          role={role}
        />
        <CreatePeopleCampaignSheet
          dataSource={dataSource}
          entitlement={entitlement}
          fieldName={field.name}
          onCreated={(campaign) => {
            setCreateCampaignOpen(false);
            void goDiscovery(
              peopleCampaignDetailSearch(field.id, role.id, campaign.id),
            );
          }}
          onOpenChange={setCreateCampaignOpen}
          onRetryEntitlement={() => window.location.reload()}
          open={createCampaignOpen}
          role={role}
        />
      </div>
    );
  }

  if (mode === "people" && surface === "verticals") {
    if (!field) {
      return (
        <WorkspaceState
          description="This professional field is no longer available in the Discovery catalog."
          title="Field not found"
        />
      );
    }
    const normalizedQuery = query.trim().toLowerCase();
    const visibleRoles = readModel.roles.filter((candidate) => {
      if (statusFilter !== "all" && candidate.status !== statusFilter)
        return false;
      return (
        !normalizedQuery ||
        [candidate.name, candidate.description]
          .filter(Boolean)
          .some((value) => value?.toLowerCase().includes(normalizedQuery))
      );
    });
    return (
      <div className="space-y-6 px-9 pb-16 pt-9">
        <DiscoveryHeader
          breadcrumb="Fields"
          description={`${visibleRoles.length} Roles Available`}
          mode={mode}
          onBack={() =>
            void goDiscovery({ entity: "people", surface: "industries" })
          }
          onModeChange={changeMode}
          onQueryChange={(nextQuery) => updateFilters({ query: nextQuery })}
          query={query}
          showToolbar
          title={field.displayName ?? field.name}
          toolbarEntity="roles"
        />
        <DiscoveryListFilters
          entity="Fields"
          onFilterChange={() => undefined}
          onViewModeChange={() => undefined}
          selectedFilter="All Fields"
          showFilters={false}
          total={visibleRoles.length}
          viewMode="grid"
        />
        <EntitlementNotice entitlement={entitlement} />
        <RoleGrid
          fieldName={field.name}
          roles={visibleRoles}
          onSelect={(selectedRole) =>
            void goDiscovery(roleCampaignsSearch(field.id, selectedRole.id))
          }
        />
      </div>
    );
  }

  if (mode === "people" && surface === "industries") {
    const normalizedQuery = query.trim().toLowerCase();
    const visibleFields = readModel.fields.filter((candidate) => {
      if (statusFilter !== "all" && candidate.status !== statusFilter)
        return false;
      return (
        !normalizedQuery ||
        [candidate.name, candidate.displayName, candidate.description]
          .filter(Boolean)
          .some((value) => value?.toLowerCase().includes(normalizedQuery))
      );
    });
    return (
      <div className="space-y-6 px-9 pb-16 pt-9">
        <DiscoveryHeader
          mode={mode}
          onModeChange={changeMode}
          onQueryChange={(nextQuery) => updateFilters({ query: nextQuery })}
          query={query}
          showToolbar
          title=""
          toolbarEntity="fields and roles"
        />
        <EntitlementNotice entitlement={entitlement} />
        <DiscoveryListFilters
          entity="Fields"
          onFilterChange={() => undefined}
          onViewModeChange={() => undefined}
          selectedFilter="All Fields"
          total={visibleFields.length}
          viewMode="grid"
        />
        <FieldGrid
          fields={visibleFields}
          onSelect={(selectedField) =>
            void goDiscovery(fieldRolesSearch(selectedField.id))
          }
        />
      </div>
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
      <div className="relative space-y-6 px-9 pb-16 pt-9">
        <DiscoveryHeader
          breadcrumb="Industries"
          description={`${visibleVerticals.length} Verticals Available`}
          mode={mode}
          onBack={() => void goDiscovery({ surface: "industries" })}
          onModeChange={changeMode}
          onQueryChange={(nextQuery) => updateFilters({ query: nextQuery })}
          query={query}
          showToolbar
          title={industry?.name ?? vertical.industryId}
          toolbarEntity="verticals"
        />
        <DiscoveryListFilters
          onFilterChange={() => undefined}
          onViewModeChange={() => undefined}
          selectedFilter="All Industries"
          total={visibleVerticals.length}
          viewMode="grid"
          showFilters={false}
        />
        <VerticalGrid
          industryName={industry?.name ?? vertical.industryId}
          onSelect={(selectedVertical) =>
            void goDiscovery(
              verticalCampaignsSearch(
                selectedVertical.industryId,
                selectedVertical.id,
              ),
            )
          }
          verticals={visibleVerticals}
        />
        <EntitlementNotice entitlement={entitlement} />
        <CampaignListView
          campaigns={vertical.campaigns}
          industryName={industry?.name}
          onBack={() =>
            void goDiscovery(industryVerticalSearch(vertical.industryId))
          }
          onCreateCampaign={() => setCreateCampaignOpen(true)}
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
      <div className="space-y-6 px-9 pb-16 pt-9">
        <DiscoveryHeader
          breadcrumb="Industries"
          description={`${visibleVerticals.length} Verticals Available`}
          mode={mode}
          onBack={() => void goDiscovery({ surface: "industries" })}
          onModeChange={changeMode}
          onQueryChange={(nextQuery) => updateFilters({ query: nextQuery })}
          onStatusFilterChange={(nextStatus) =>
            updateFilters({ statusFilter: nextStatus })
          }
          query={query}
          showToolbar
          statusFilter={statusFilter}
          title={industry.name}
          toolbarEntity="verticals"
        />
        <DiscoveryListFilters
          onFilterChange={() => undefined}
          onViewModeChange={() => undefined}
          selectedFilter="All Industries"
          total={visibleVerticals.length}
          viewMode="grid"
          showFilters={false}
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
      <div className="px-9 pb-16 pt-9">
        <LeadsWorkspace
          dataSource={dataSource}
          initialLeads={readModel.leads}
          initialMode={mode === "people" ? "people" : "companies"}
          scope="global"
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
    <div className="space-y-6 px-9 pb-16 pt-9">
      <DiscoveryHeader
        description=""
        mode={mode}
        onModeChange={changeMode}
        onQueryChange={(nextQuery) => updateFilters({ query: nextQuery })}
        onStatusFilterChange={(nextStatus) =>
          updateFilters({ statusFilter: nextStatus })
        }
        query={query}
        showToolbar
        statusFilter={statusFilter}
        title=""
        toolbarEntity="industries"
      />
      <EntitlementNotice entitlement={entitlement} />
      <DiscoveryListFilters
        onFilterChange={() => undefined}
        onViewModeChange={() => undefined}
        selectedFilter="All Industries"
        total={visibleIndustries.length}
        viewMode="grid"
      />
      <IndustryGrid
        industries={visibleIndustries}
        onSelect={(industryToOpen) =>
          void goDiscovery(industryVerticalSearch(industryToOpen.id))
        }
      />
    </div>
  );
}
