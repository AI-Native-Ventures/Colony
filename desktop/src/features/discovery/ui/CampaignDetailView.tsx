import * as React from "react";
import { ArrowLeft, CalendarDays, LockKeyhole } from "lucide-react";

import type { DiscoverySearch } from "@/app/routes/discovery";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import type { DiscoveryEntitlement } from "../entitlement";
import type { DiscoveryDataSource } from "../data/DiscoveryDataSource";
import type { CampaignDetail, LeadPage } from "../types";
import { useDiscoveryRun } from "../useDiscoveryRun";
import { EntitlementLock } from "./EntitlementLock";
import { CampaignTabs, type CampaignTab } from "./CampaignTabs";
import { DiscoveryRunTab } from "./DiscoveryRunTab";
import { OverviewTab } from "./OverviewTab";
import { SourceConfigEditor } from "./SourceConfigEditor";
import { LeadsWorkspace } from "./LeadsWorkspace";
import { campaignTabForSearch } from "./discoveryLayout";

export type CampaignDetailViewProps = {
  campaign: CampaignDetail;
  dataSource: DiscoveryDataSource;
  entitlement: DiscoveryEntitlement | null;
  search: DiscoverySearch;
  leads?: LeadPage | null;
  onBack: () => void;
  onTabChange: (tab: CampaignTab) => void;
};

function statusVariant(status: CampaignDetail["status"]) {
  if (status === "ready") return "success" as const;
  if (status === "completed") return "success" as const;
  if (status === "running") return "info" as const;
  if (status === "failed" || status === "cancelled")
    return "destructive" as const;
  if (status === "partial") return "warning" as const;
  return "secondary" as const;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function ViewOnlyTab({
  tab,
  campaign,
  dataSource,
  entitlement,
  onUpdated,
}: {
  tab: Exclude<CampaignTab, "overview" | "discovery" | "leads">;
  campaign: CampaignDetail;
  dataSource: DiscoveryDataSource;
  entitlement: DiscoveryEntitlement | null;
  onUpdated: (campaign: CampaignDetail) => void;
}) {
  const copy: Record<typeof tab, { title: string; description: string }> = {
    outreach: {
      title: "Outreach is ready for the next phase",
      description:
        "Multichannel outreach will use this campaign's verified leads. Delivery controls are intentionally not connected in the fixture workspace.",
    },
    conversations: {
      title: "Conversations will appear here",
      description:
        "Replies and handoffs will become visible here after outreach is connected. There are no fake messages in this view.",
    },
    settings: {
      title: "Campaign settings",
      description: "Manage the sources that this campaign uses for discovery.",
    },
  };
  const content = copy[tab];
  if (tab === "settings") {
    return (
      <div className="space-y-4">
        <Card className="border-border/60 bg-card/70 p-5 shadow-none">
          <h2 className="text-lg font-semibold text-foreground">
            {content.title}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {content.description}
          </p>
        </Card>
        <SourceConfigEditor
          campaign={campaign}
          dataSource={dataSource}
          entitlement={entitlement}
          onUpdated={onUpdated}
        />
      </div>
    );
  }
  return (
    <Card className="border-dashed border-border/70 bg-background/30 p-8 text-center shadow-none">
      <LockKeyhole
        aria-hidden="true"
        className="mx-auto h-8 w-8 text-muted-foreground"
      />
      <Badge className="mt-3" variant="secondary">
        View only
      </Badge>
      <h2 className="mt-3 text-lg font-semibold text-foreground">
        {content.title}
      </h2>
      <p className="mx-auto mt-1 max-w-xl text-sm text-muted-foreground">
        {content.description}
      </p>
    </Card>
  );
}

export function CampaignDetailView({
  campaign,
  dataSource,
  entitlement,
  search,
  onBack,
  onTabChange,
  leads = null,
}: CampaignDetailViewProps) {
  const [campaignState, setCampaignState] = React.useState(campaign);
  React.useEffect(() => {
    setCampaignState(campaign);
  }, [campaign]);
  const runState = useDiscoveryRun(campaignState, dataSource, entitlement);
  const activeTab: CampaignTab = campaignTabForSearch(search);
  const effectiveStatus =
    runState.run.status === "idle" ? campaignState.status : runState.run.status;
  const displayStatus = effectiveStatus === "ready" ? "live" : effectiveStatus;

  return (
    <div className="mx-auto max-w-[65rem] px-[2.375rem] pb-16 pt-7">
      <header className="space-y-4 border-b border-border/50 pb-1">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <Button
              className="-ml-2 mb-5"
              onClick={onBack}
              type="button"
              variant="ghost"
            >
              <ArrowLeft aria-hidden="true" />
              Back to {campaignState.verticalName}
            </Button>
            <div className="mb-2.5 flex flex-wrap items-center gap-3">
              <h1 className="font-serif text-title font-normal leading-none tracking-tight text-foreground">
                {campaignState.name}
              </h1>
              <Badge variant={statusVariant(effectiveStatus)}>
                {displayStatus}
              </Badge>
            </div>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-2xs text-muted-foreground">
              <span>{campaignState.industryName}</span>
              <span aria-hidden="true">·</span>
              <span>{campaignState.verticalName}</span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1">
                <CalendarDays aria-hidden="true" className="h-3.5 w-3.5" />
                created {formatDate(campaignState.createdAt)}
              </span>
            </p>
          </div>
          {activeTab !== "discovery" ? (
            <div className="flex shrink-0 items-center gap-2 pt-1">
              <EntitlementLock
                actionLabel="Run Discovery"
                entitlement={entitlement}
                className="rounded-full px-5"
                onRetry={() => window.location.reload()}
                onRun={runState.start}
              />
            </div>
          ) : null}
        </div>
        <CampaignTabs
          leadCount={campaignState.leadCount}
          onValueChange={onTabChange}
          value={activeTab}
        />
      </header>

      <div className="pt-7">
        {activeTab === "overview" ? (
          <OverviewTab
            campaign={campaignState}
            leadCount={Math.max(campaignState.leadCount, runState.run.stored)}
          />
        ) : null}
        {activeTab === "discovery" ? (
          <DiscoveryRunTab
            campaign={campaignState}
            entitlement={entitlement}
            runState={runState}
          />
        ) : null}
        {activeTab === "leads" ? (
          <LeadsWorkspace
            campaign={campaignState}
            dataSource={dataSource}
            initialLeads={leads}
            scope="campaign"
          />
        ) : null}
        {activeTab === "outreach" ||
        activeTab === "conversations" ||
        activeTab === "settings" ? (
          <ViewOnlyTab
            campaign={campaignState}
            dataSource={dataSource}
            entitlement={entitlement}
            onUpdated={setCampaignState}
            tab={activeTab}
          />
        ) : null}
      </div>
    </div>
  );
}
