import * as React from "react";
import {
  Download,
  Grid2X2,
  List,
  Plus,
  RefreshCw,
  SearchCheck,
  UsersRound,
} from "lucide-react";

import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import type { DiscoverySearch } from "@/app/routes/discovery";
import type { DiscoveryDataSource } from "../data/DiscoveryDataSource";
import { describeExportOutcome, exportLeadsToCsv } from "../lib/exportLeads";
import type { CampaignDetail, LeadPage } from "../types";
import {
  EMPTY_LEAD_FILTERS,
  filterLeads,
  type LeadFilterState,
  type LeadMode,
} from "./LeadFilters";
import { LeadFilters } from "./LeadFilters";
import { LeadTable, type LeadTableView } from "./LeadTable";
import { PeopleLeadTable } from "./PeopleLeadTable";
import { CampaignLeadStatsRow, GlobalLeadStatsRow } from "./LeadsStats";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";

export type LeadsWorkspaceProps = {
  dataSource: DiscoveryDataSource;
  initialLeads?: LeadPage | null;
  campaign?: CampaignDetail | null;
  scope: "campaign" | "global";
  initialMode?: LeadMode;
  search: DiscoverySearch;
};

/**
 * The message for an action that is not built yet.
 *
 * It says so plainly. The previous wording claimed the action had
 * "completed", which told the person their leads had been deduplicated or
 * grouped when nothing had happened at all.
 */
function notYetAvailable(action: string) {
  return `${action} is not available yet.`;
}

function ViewToggle({
  value,
  onChange,
}: {
  value: LeadTableView;
  onChange: (value: LeadTableView) => void;
}) {
  return (
    <fieldset
      aria-label="Lead view"
      className="inline-flex rounded-lg border border-input/40 bg-background p-1"
    >
      <Button
        aria-label="List view"
        aria-pressed={value === "list"}
        onClick={() => onChange("list")}
        size="icon-xs"
        type="button"
        variant={value === "list" ? "secondary" : "ghost"}
      >
        <List aria-hidden="true" />
      </Button>
      <Button
        aria-label="Grid view"
        aria-pressed={value === "grid"}
        onClick={() => onChange("grid")}
        size="icon-xs"
        type="button"
        variant={value === "grid" ? "secondary" : "ghost"}
      >
        <Grid2X2 aria-hidden="true" />
      </Button>
    </fieldset>
  );
}

function ActionStatus({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      aria-live="polite"
      className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-muted-foreground"
      role="status"
    >
      {message}
    </div>
  );
}

function CampaignActionBar({
  onAction,
}: {
  onAction: (action: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        onClick={() => onAction("Deduplicate")}
        size="sm"
        type="button"
        variant="outline"
      >
        <RefreshCw aria-hidden="true" />
        Deduplicate
      </Button>
      <Button
        onClick={() => onAction("Export")}
        size="sm"
        type="button"
        variant="outline"
      >
        <Download aria-hidden="true" />
        Export
      </Button>
      <Button
        onClick={() => onAction("Find websites")}
        size="sm"
        type="button"
        variant="outline"
      >
        <SearchCheck aria-hidden="true" />
        Find websites
      </Button>
      <Button onClick={() => onAction("Add lead")} size="sm" type="button">
        <Plus aria-hidden="true" />
        Add lead
      </Button>
    </div>
  );
}

function CampaignLeads({
  campaign,
  dataSource,
  initialLeads,
  search,
}: {
  campaign: CampaignDetail;
  dataSource: DiscoveryDataSource;
  initialLeads: LeadPage | null | undefined;
  search: DiscoverySearch;
}) {
  const [page, setPage] = React.useState<LeadPage | null>(initialLeads ?? null);
  const [isLoading, setIsLoading] = React.useState(!initialLeads);
  const [filters, setFilters] =
    React.useState<LeadFilterState>(EMPTY_LEAD_FILTERS);
  const [view, setView] = React.useState<LeadTableView>("list");
  const [message, setMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    if (initialLeads) {
      setPage(initialLeads);
      setIsLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setIsLoading(true);
    void dataSource
      .getLeads({
        scope: "campaign",
        campaignId: campaign.id,
        page: 1,
        pageSize: 100,
      })
      .then((nextPage) => {
        if (cancelled) return;
        setPage(nextPage);
        setIsLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setPage({
            leads: [],
            total: 0,
            page: 1,
            pageSize: 100,
            hasNextPage: false,
          });
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [campaign.id, dataSource, initialLeads]);

  const leads = page?.leads ?? [];
  const visibleLeads = filterLeads(leads, filters);
  const people = campaign.targetType === "individual";
  if (isLoading) {
    return <LoadingLeads />;
  }

  return (
    <div className="space-y-4">
      <CampaignLeadStatsRow leads={leads} people={people} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            {visibleLeads.length} of {leads.length}{" "}
            {people ? "people" : "leads"} shown
          </p>
        </div>
        <CampaignActionBar
          onAction={(action) => {
            if (action !== "Export") {
              setMessage(notYetAvailable(action));
              return;
            }
            void exportLeadsToCsv(visibleLeads, campaign.name ?? "leads").then(
              (outcome) =>
                setMessage(
                  describeExportOutcome(outcome, people ? "people" : "leads") ??
                    "",
                ),
            );
          }}
        />
      </div>
      <ActionStatus message={message} />
      <LeadFilters
        campaign
        leads={leads}
        onChange={(next) => setFilters((current) => ({ ...current, ...next }))}
        value={filters}
        people={people}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">
            {visibleLeads.length} {people ? "people" : "leads"}
          </Badge>
          <span>Verified discovery results</span>
        </div>
        <ViewToggle onChange={setView} value={view} />
      </div>
      {people ? (
        <PeopleLeadTable
          leads={visibleLeads}
          scope="campaign"
          search={search}
          view={view}
        />
      ) : (
        <LeadTable
          leads={visibleLeads}
          scope="campaign"
          search={search}
          view={view}
        />
      )}
    </div>
  );
}

function GlobalLeads({
  dataSource,
  initialLeads,
  initialMode,
  search,
}: {
  dataSource: DiscoveryDataSource;
  initialLeads: LeadPage | null | undefined;
  initialMode: LeadMode;
  search: DiscoverySearch;
}) {
  const [page, setPage] = React.useState<LeadPage | null>(initialLeads ?? null);
  const [isLoading, setIsLoading] = React.useState(!initialLeads);
  const [filters, setFilters] =
    React.useState<LeadFilterState>(EMPTY_LEAD_FILTERS);
  const [mode, setMode] = React.useState<LeadMode>(initialMode);
  const [view, setView] = React.useState<LeadTableView>("list");
  const [message, setMessage] = React.useState<string | null>(null);
  const { goDiscovery } = useAppNavigation();

  React.useEffect(() => setMode(initialMode), [initialMode]);

  React.useEffect(() => {
    let cancelled = false;
    if (initialLeads) {
      setPage(initialLeads);
      setIsLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setIsLoading(true);
    void dataSource
      .getLeads({ scope: "global", page: 1, pageSize: 500 })
      .then((nextPage) => {
        if (cancelled) return;
        setPage(nextPage);
        setIsLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setPage({
            leads: [],
            total: 0,
            page: 1,
            pageSize: 100,
            hasNextPage: false,
          });
          setIsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dataSource, initialLeads]);

  const leads = page?.leads ?? [];
  const modeLeads = leads.filter((lead) =>
    mode === "people"
      ? lead.entityType === "person"
      : lead.entityType !== "person",
  );
  const visibleLeads = filterLeads(modeLeads, filters);
  if (isLoading) return <LoadingLeads />;

  if (leads.length === 0) {
    return (
      <div className="space-y-5">
        <GlobalLeadsHeader
          mode={mode}
          onModeChange={setMode}
          onAction={setMessage}
          onExport={() => undefined}
        />
        <Card
          className="border-dashed border-border/70 bg-background/30 p-10 text-center shadow-none"
          data-testid="leads-empty-state"
        >
          <UsersRound
            aria-hidden="true"
            className="mx-auto h-8 w-8 text-muted-foreground"
          />
          <h2 className="mt-3 text-lg font-semibold text-foreground">
            No leads yet
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Run a Discovery campaign and every retained business appears here
            automatically.
          </p>
          <Button
            className="mt-5"
            data-testid="discover-more-button"
            onClick={() => void goDiscovery({ surface: "industries" })}
            type="button"
          >
            <Plus aria-hidden="true" />
            Discover more
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <GlobalLeadsHeader
        mode={mode}
        onModeChange={setMode}
        onAction={setMessage}
        onExport={() => {
          void exportLeadsToCsv(
            visibleLeads,
            mode === "people" ? "people" : "companies",
          ).then((outcome) =>
            setMessage(
              describeExportOutcome(
                outcome,
                mode === "people" ? "people" : "companies",
              ) ?? "",
            ),
          );
        }}
      />
      <GlobalLeadStatsRow leads={modeLeads} people={mode === "people"} />
      <ActionStatus message={message} />
      <LeadFilters
        leads={modeLeads}
        onChange={(next) => setFilters((current) => ({ ...current, ...next }))}
        value={filters}
        people={mode === "people"}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {visibleLeads.length} {mode === "people" ? "people" : "companies"} in
          this workspace
        </p>
        <ViewToggle onChange={setView} value={view} />
      </div>
      {mode === "people" ? (
        <PeopleLeadTable
          leads={visibleLeads}
          scope="global"
          search={search}
          view={view}
        />
      ) : (
        <LeadTable
          leads={visibleLeads}
          scope="global"
          search={search}
          view={view}
        />
      )}
    </div>
  );
}

function GlobalLeadsHeader({
  mode,
  onAction,
  onExport,
  onModeChange,
}: {
  mode: LeadMode;
  onAction: (message: string) => void;
  onExport: () => void;
  onModeChange: (mode: LeadMode) => void;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border/50 pb-4">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Leads.
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === "people"
            ? "Find, enrich, and manage the professionals your company should reach."
            : "Find, enrich, and manage the businesses your company can serve."}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => onAction(notYetAvailable("Groups"))}
          size="sm"
          type="button"
          variant="outline"
        >
          <UsersRound aria-hidden="true" />
          Groups
        </Button>
        <Button onClick={onExport} size="sm" type="button" variant="outline">
          <Download aria-hidden="true" />
          Export
        </Button>
        <Button
          onClick={() => onAction(notYetAvailable("New campaign"))}
          size="sm"
          type="button"
        >
          <Plus aria-hidden="true" />
          New campaign
        </Button>
      </div>
      <Tabs
        className="w-full"
        onValueChange={(next) => {
          if (next === "companies" || next === "people") onModeChange(next);
        }}
        value={mode}
      >
        <TabsList>
          <TabsTrigger value="companies">Companies</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
        </TabsList>
      </Tabs>
    </header>
  );
}

function LoadingLeads() {
  return (
    <div aria-busy="true" className="space-y-4">
      <div className="h-24 animate-pulse rounded-xl bg-muted/40" />
      <div className="h-12 animate-pulse rounded-xl bg-muted/35" />
      <div className="h-96 animate-pulse rounded-xl bg-muted/35" />
      <span className="sr-only">Loading leads</span>
    </div>
  );
}

export function LeadsWorkspace({
  campaign = null,
  dataSource,
  initialMode = "companies",
  initialLeads,
  scope,
  search,
}: LeadsWorkspaceProps) {
  if (scope === "campaign" && campaign) {
    return (
      <CampaignLeads
        campaign={campaign}
        dataSource={dataSource}
        initialLeads={initialLeads}
        search={search}
      />
    );
  }
  return (
    <GlobalLeads
      dataSource={dataSource}
      initialLeads={initialLeads}
      initialMode={initialMode}
      search={search}
    />
  );
}
