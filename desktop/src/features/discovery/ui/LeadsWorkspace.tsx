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
import type { DiscoveryDataSource } from "../data/DiscoveryDataSource";
import type { CampaignDetail, LeadPage } from "../types";
import {
  EMPTY_LEAD_FILTERS,
  filterLeads,
  type LeadFilterState,
  type LeadMode,
} from "./LeadFilters";
import { LeadFilters } from "./LeadFilters";
import { LeadTable, type LeadTableView } from "./LeadTable";
import {
  CampaignLeadStatsRow,
  GlobalLeadStatsRow,
  LeadsEmptyState,
} from "./LeadsStats";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";

export type LeadsWorkspaceProps = {
  dataSource: DiscoveryDataSource;
  initialLeads?: LeadPage | null;
  campaign?: CampaignDetail | null;
  scope: "campaign" | "global";
};

function actionMessage(action: string) {
  return `${action} is a fixture workspace action. Connect a provider before running it.`;
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
}: {
  campaign: CampaignDetail;
  dataSource: DiscoveryDataSource;
  initialLeads: LeadPage | null | undefined;
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
  if (isLoading) {
    return <LoadingLeads />;
  }

  return (
    <div className="space-y-4">
      <CampaignLeadStatsRow leads={leads} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">
            {visibleLeads.length} of {leads.length} leads shown
          </p>
        </div>
        <CampaignActionBar
          onAction={(action) => setMessage(actionMessage(action))}
        />
      </div>
      <ActionStatus message={message} />
      <LeadFilters
        campaign
        leads={leads}
        onChange={(next) => setFilters((current) => ({ ...current, ...next }))}
        value={filters}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">{visibleLeads.length} leads</Badge>
          <span>Verified discovery results</span>
        </div>
        <ViewToggle onChange={setView} value={view} />
      </div>
      <LeadTable leads={visibleLeads} scope="campaign" view={view} />
    </div>
  );
}

function GlobalLeads({
  dataSource,
  initialLeads,
}: {
  dataSource: DiscoveryDataSource;
  initialLeads: LeadPage | null | undefined;
}) {
  const [page, setPage] = React.useState<LeadPage | null>(initialLeads ?? null);
  const [isLoading, setIsLoading] = React.useState(!initialLeads);
  const [filters, setFilters] =
    React.useState<LeadFilterState>(EMPTY_LEAD_FILTERS);
  const [mode, setMode] = React.useState<LeadMode>("companies");
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
      .getLeads({ scope: "global", page: 1, pageSize: 100 })
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
  const visibleLeads = filterLeads(leads, filters);
  if (isLoading) return <LoadingLeads />;

  return (
    <div className="space-y-5">
      <GlobalLeadsHeader
        mode={mode}
        onModeChange={setMode}
        onAction={setMessage}
      />
      <GlobalLeadStatsRow leads={leads} />
      <ActionStatus message={message} />
      <LeadFilters
        leads={leads}
        onChange={(next) => setFilters((current) => ({ ...current, ...next }))}
        value={filters}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {mode === "people"
            ? "People discovery is not connected"
            : `${visibleLeads.length} companies in this workspace`}
        </p>
        <ViewToggle onChange={setView} value={view} />
      </div>
      {mode === "people" ? (
        <LeadsEmptyState people />
      ) : (
        <LeadTable leads={visibleLeads} scope="global" view={view} />
      )}
    </div>
  );
}

function GlobalLeadsHeader({
  mode,
  onAction,
  onModeChange,
}: {
  mode: LeadMode;
  onAction: (message: string) => void;
  onModeChange: (mode: LeadMode) => void;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border/50 pb-4">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Leads.
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Find, enrich, and manage the businesses your company can serve.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => onAction(actionMessage("Groups"))}
          size="sm"
          type="button"
          variant="outline"
        >
          <UsersRound aria-hidden="true" />
          Groups
        </Button>
        <Button
          onClick={() => onAction(actionMessage("Export"))}
          size="sm"
          type="button"
          variant="outline"
        >
          <Download aria-hidden="true" />
          Export
        </Button>
        <Button
          onClick={() => onAction(actionMessage("New campaign"))}
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
  initialLeads,
  scope,
}: LeadsWorkspaceProps) {
  if (scope === "campaign" && campaign) {
    return (
      <CampaignLeads
        campaign={campaign}
        dataSource={dataSource}
        initialLeads={initialLeads}
      />
    );
  }
  return <GlobalLeads dataSource={dataSource} initialLeads={initialLeads} />;
}
