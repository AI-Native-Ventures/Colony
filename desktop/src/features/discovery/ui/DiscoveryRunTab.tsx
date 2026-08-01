import {
  CheckCircle2,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  StopCircle,
} from "lucide-react";

import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { Progress } from "@/shared/ui/progress";
import { canStartDiscovery, type DiscoveryEntitlement } from "../entitlement";
import type { CampaignDetail } from "../types";
import type { UseDiscoveryRunResult } from "../useDiscoveryRun";
import { DISCOVERY_SOURCE_LABELS } from "../sourceConfig";
import { EntitlementLock } from "./EntitlementLock";
import { DiscoveryTimeline } from "./DiscoveryTimeline";
import { SourceStatusTable } from "./SourceStatusTable";

export type DiscoveryRunTabProps = {
  campaign: CampaignDetail;
  entitlement: DiscoveryEntitlement | null;
  runState: UseDiscoveryRunResult;
};

function terminalCopy(status: UseDiscoveryRunResult["run"]["status"]) {
  if (status === "partial") {
    return "The target was not fully reached, but the leads found so far are ready to review.";
  }
  if (status === "cancelled") {
    return "This run was cancelled. You can retry it when you are ready.";
  }
  if (status === "failed") {
    return "The run stopped because a source failed. Retry to let the agent continue with the available sources.";
  }
  if (status === "completed") {
    return "Discovery is complete. Review the leads or find more businesses for this campaign.";
  }
  return "Jen will search the configured sources and add qualifying businesses to this campaign.";
}

function ActionButton({
  actionLabel,
  entitlement,
  onRun,
}: {
  actionLabel: string;
  entitlement: DiscoveryEntitlement | null;
  onRun: () => void;
}) {
  if (!canStartDiscovery({ state: entitlement?.state ?? "loading" })) {
    return (
      <EntitlementLock
        actionLabel={actionLabel}
        entitlement={entitlement}
        onRetry={() => window.location.reload()}
        onRun={onRun}
      />
    );
  }
  return (
    <Button onClick={onRun} type="button">
      <Play aria-hidden="true" />
      {actionLabel}
    </Button>
  );
}

function RunHero({ campaign, entitlement, runState }: DiscoveryRunTabProps) {
  const { run } = runState;
  const status = run.status;
  const isRunning = runState.busy || status === "running";
  const actionLabel =
    status === "completed" || status === "partial"
      ? "Find More Leads"
      : "Start Discovery";
  return (
    <Card className="overflow-hidden border-border/60 bg-gradient-to-br from-primary/10 via-card/80 to-card/80 p-0 shadow-none">
      <div className="flex flex-wrap items-center gap-5 p-5 sm:p-7">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full border-4 border-background bg-primary/15 text-primary shadow-sm">
          <Sparkles aria-hidden="true" className="h-7 w-7" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-2xs font-medium uppercase tracking-[0.18em] text-primary">
            Discovery agent · Jen
          </p>
          <h2 className="mt-1 text-xl font-semibold text-foreground sm:text-2xl">
            {isRunning
              ? "Discovery is running"
              : status === "idle"
                ? "Ready to discover"
                : "Discovery complete"}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {terminalCopy(status)}
          </p>
          {runState.error ? (
            <p className="mt-2 text-sm text-destructive" role="alert">
              {runState.error}
            </p>
          ) : null}
        </div>
        <div className="flex min-w-[12rem] flex-col gap-2 sm:items-end">
          {isRunning ? (
            <Button onClick={runState.cancel} type="button" variant="outline">
              <StopCircle aria-hidden="true" />
              Cancel run
            </Button>
          ) : status === "failed" || status === "cancelled" ? (
            <ActionButton
              actionLabel="Retry discovery"
              entitlement={entitlement}
              onRun={runState.retry}
            />
          ) : (
            <ActionButton
              actionLabel={actionLabel}
              entitlement={entitlement}
              onRun={runState.start}
            />
          )}
          {status !== "idle" && !isRunning ? (
            <Button onClick={runState.reset} type="button" variant="ghost">
              <RotateCcw aria-hidden="true" />
              Start Over
            </Button>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 border-t border-border/50 bg-background/30 p-4 sm:grid-cols-4">
        <div className="rounded-lg border border-border/50 bg-card/70 p-3">
          <p className="text-2xs uppercase tracking-[0.16em] text-muted-foreground">
            New
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {run.stored}
          </p>
          <p className="text-xs text-muted-foreground">this session</p>
        </div>
        <div className="rounded-lg border border-border/50 bg-card/70 p-3">
          <p className="text-2xs uppercase tracking-[0.16em] text-muted-foreground">
            Total
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {Math.max(campaign.leadCount, run.stored)}
          </p>
          <p className="text-xs text-muted-foreground">campaign leads</p>
        </div>
        <div className="col-span-2 rounded-lg border border-border/50 bg-card/70 p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-2xs uppercase tracking-[0.16em] text-muted-foreground">
              Target progress
            </p>
            <span className="text-sm font-medium tabular-nums text-foreground">
              {run.completion}%
            </span>
          </div>
          <Progress
            aria-label="Discovery target progress"
            className="mt-3"
            value={run.completion}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {run.stored} of {run.target} new leads found
          </p>
        </div>
      </div>
    </Card>
  );
}

export function DiscoveryRunTab({
  campaign,
  entitlement,
  runState,
}: DiscoveryRunTabProps) {
  const activeSources = campaign.sourceConfig.order;
  const activeSource = runState.run.currentSource;
  return (
    <div className="space-y-5">
      <RunHero
        campaign={campaign}
        entitlement={entitlement}
        runState={runState}
      />
      <Card className="border-border/60 bg-card/70 p-4 shadow-none">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              Sources in this run
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {campaign.sourceConfig.mode === "waterfall"
                ? "Jen checks each enabled source in order until the target is reached."
                : "Jen checks all enabled sources concurrently."}
            </p>
          </div>
          <Badge variant="outline">{activeSources.length} enabled</Badge>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {activeSources.map((source) => (
            <Badge
              key={source}
              variant={source === activeSource ? "info" : "secondary"}
            >
              {source === activeSource ? (
                <RefreshCw aria-hidden="true" className="animate-spin" />
              ) : (
                <CheckCircle2 aria-hidden="true" />
              )}
              {DISCOVERY_SOURCE_LABELS[source]}
            </Badge>
          ))}
        </div>
      </Card>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(22rem,0.75fr)]">
        <section
          aria-labelledby="discovery-timeline-heading"
          className="space-y-3"
        >
          <div>
            <h2
              className="text-base font-semibold text-foreground"
              id="discovery-timeline-heading"
            >
              Run timeline
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Streaming updates from the discovery agent.
            </p>
          </div>
          <DiscoveryTimeline items={runState.timeline} />
        </section>
        <SourceStatusTable metrics={runState.run.sourceMetrics} />
      </div>
    </div>
  );
}
