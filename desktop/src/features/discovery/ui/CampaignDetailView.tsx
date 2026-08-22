import * as React from "react";
import { ArrowLeft, CalendarDays, Coins, Loader2 } from "lucide-react";

import type { DiscoverySearch } from "@/app/routes/discovery";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import type { DiscoveryEntitlement } from "../entitlement";
import type { DiscoveryDataSource } from "../data/DiscoveryDataSource";
import type { CampaignDetail, LeadPage } from "../types";
import {
  approvedCampaignBudgetNanousd,
  formatDiscoveryNanousd,
} from "../data/campaignBudget";
import { useDiscoveryRun } from "../useDiscoveryRun";
import { EntitlementLock } from "./EntitlementLock";
import { CampaignTabs, type CampaignTab } from "./CampaignTabs";
import { DiscoveryRunTab } from "./DiscoveryRunTab";
import { OverviewTab } from "./OverviewTab";
import { LeadsWorkspace } from "./LeadsWorkspace";
import { campaignTabForSearch } from "./discoveryLayout";
import { CampaignOutreachTab } from "./CampaignOutreachTab";
import { CampaignConversationsTab } from "./CampaignConversationsTab";

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

function SettingsTab({
  campaign,
  dataSource,
  entitlement,
  onUpdated,
}: {
  campaign: CampaignDetail;
  dataSource: DiscoveryDataSource;
  entitlement: DiscoveryEntitlement | null;
  onUpdated: (campaign: CampaignDetail) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const budget = campaign.budget;

  async function change(action: "approve" | "pause" | "revoke"): Promise<void> {
    if (
      action === "revoke" &&
      !window.confirm(
        "Permanently revoke this Campaign budget? This cannot be resumed.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated =
        action === "approve"
          ? await dataSource.approveCampaignBudget(campaign.id)
          : action === "pause"
            ? await dataSource.pauseCampaignBudget(campaign.id)
            : await dataSource.revokeCampaignBudget(campaign.id);
      onUpdated(updated);
    } catch (cause: unknown) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The Campaign budget could not be changed.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">
          Campaign settings
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage the Colony Credits approved for this Campaign.
        </p>
      </div>
      <Card className="space-y-5 border-border/60 p-6 shadow-none">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
            <Coins aria-hidden="true" className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="font-semibold text-foreground">
                Discovery budget
              </h3>
              <Badge
                variant={budget?.state === "active" ? "success" : "secondary"}
              >
                {budget?.state ?? "unapproved"}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              5¢ per newly retained, deduplicated lead. Colony chooses and funds
              the data source.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Approved", budget?.approvedNanousd ?? "0"],
            ["Spent", budget?.spentNanousd ?? "0"],
            ["Reserved", budget?.reservedNanousd ?? "0"],
            ["Remaining", budget?.remainingNanousd ?? "0"],
          ].map(([label, value]) => (
            <div className="rounded-xl bg-muted/50 p-3" key={label}>
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="mt-1 font-mono text-sm font-semibold text-foreground">
                {formatDiscoveryNanousd(value)}
              </p>
            </div>
          ))}
        </div>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {(!budget ||
            budget.state === "unapproved" ||
            budget.state === "paused") &&
          entitlement?.experience === "live" ? (
            <Button disabled={busy} onClick={() => void change("approve")}>
              {busy ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : null}
              {budget?.state === "paused"
                ? "Resume budget"
                : `Approve ${formatDiscoveryNanousd(
                    approvedCampaignBudgetNanousd(campaign.target),
                  )}`}
            </Button>
          ) : null}
          {budget?.state === "active" ? (
            <Button
              disabled={busy}
              onClick={() => void change("pause")}
              variant="outline"
            >
              Pause new runs
            </Button>
          ) : null}
          {budget &&
          budget.state !== "unapproved" &&
          budget.state !== "revoked" ? (
            <Button
              disabled={busy}
              onClick={() => void change("revoke")}
              variant="destructive"
            >
              Revoke budget
            </Button>
          ) : null}
        </div>
      </Card>
    </div>
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
  const liveBusinessPhase = entitlement?.experience === "live";
  const outsideLivePhase =
    liveBusinessPhase &&
    (activeTab === "outreach" || activeTab === "conversations");
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
              Back to {campaignState.roleName ?? campaignState.verticalName}
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
              <span>
                {campaignState.fieldName ?? campaignState.industryName}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                {campaignState.roleName ?? campaignState.verticalName}
              </span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1">
                <CalendarDays aria-hidden="true" className="h-3.5 w-3.5" />
                created {formatDate(campaignState.createdAt)}
              </span>
            </p>
          </div>
          {activeTab !== "discovery" ? (
            <div className="flex shrink-0 items-center gap-2 pt-1">
              {entitlement?.state === "entitled" && !runState.canStart ? (
                <Button className="rounded-full px-5" disabled>
                  Run Discovery
                </Button>
              ) : (
                <EntitlementLock
                  actionLabel="Run Discovery"
                  entitlement={entitlement}
                  className="rounded-full px-5"
                  onRetry={() => window.location.reload()}
                  onRun={runState.start}
                />
              )}
            </div>
          ) : null}
        </div>
        <CampaignTabs
          leadCount={campaignState.leadCount}
          liveBusinessPhase={liveBusinessPhase}
          onValueChange={onTabChange}
          value={activeTab}
        />
      </header>

      <div className="pt-7">
        {runState.error ? (
          <p className="mb-4 text-sm text-destructive" role="alert">
            {runState.error}
          </p>
        ) : null}
        {outsideLivePhase ? (
          <Card className="border-border/60 bg-card/80 p-8 text-center shadow-none">
            <h2 className="text-xl font-semibold text-foreground">
              This stays in the preview for now
            </h2>
            <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
              Live Discovery ends when a unique business is retained as a Lead.
              Multichannel Outreach and Conversations are separate production
              phases, so this campaign cannot send from them yet.
            </p>
          </Card>
        ) : null}
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
            search={search}
          />
        ) : null}
        {activeTab === "outreach" && !outsideLivePhase ? (
          <CampaignOutreachTab
            campaign={campaignState}
            dataSource={dataSource}
          />
        ) : null}
        {activeTab === "conversations" && !outsideLivePhase ? (
          <CampaignConversationsTab
            campaign={campaignState}
            dataSource={dataSource}
          />
        ) : null}
        {activeTab === "settings" ? (
          <SettingsTab
            campaign={campaignState}
            dataSource={dataSource}
            entitlement={entitlement}
            onUpdated={setCampaignState}
          />
        ) : null}
      </div>
    </div>
  );
}
