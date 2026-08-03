import { Database, Play, RotateCcw, StopCircle, Target } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import { canStartDiscovery, type DiscoveryEntitlement } from "../entitlement";
import type { CampaignDetail } from "../types";
import type { UseDiscoveryRunResult } from "../useDiscoveryRun";
import { DISCOVERY_SOURCE_LABELS } from "../sourceConfig";
import { EntitlementLock } from "./EntitlementLock";
import { DiscoveryTimeline } from "./DiscoveryTimeline";

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
  return "I'll search across global databases to discover and validate leads that match your campaign criteria.";
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
        className="rounded-full px-6"
        entitlement={entitlement}
        onRetry={() => window.location.reload()}
        onRun={onRun}
      />
    );
  }
  return (
    <Button
      aria-label={
        actionLabel === "Start Discovery Engine"
          ? "Start Discovery"
          : actionLabel
      }
      className="h-12 rounded-full bg-foreground px-8 text-base font-semibold text-background shadow-lg shadow-primary/20 transition-transform hover:scale-[1.02] hover:bg-foreground/90 active:scale-[0.99]"
      onClick={onRun}
      size="lg"
      type="button"
    >
      <Play aria-hidden="true" className="h-4 w-4" />
      {actionLabel}
    </Button>
  );
}

function JenAvatar({
  isRunning,
  isIdle,
}: {
  isRunning: boolean;
  isIdle: boolean;
}) {
  return (
    <div className="relative shrink-0">
      <div
        className={
          isRunning
            ? "rounded-full bg-gradient-to-tr from-primary to-blue-500 p-1"
            : "rounded-full bg-gradient-to-tr from-muted to-border p-1"
        }
      >
        <div
          className={
            isIdle
              ? "relative h-32 w-32 overflow-hidden rounded-full border-4 border-card shadow-2xl"
              : "relative h-20 w-20 overflow-hidden rounded-full border-4 border-card shadow-2xl"
          }
        >
          <img
            alt="Jen"
            className="h-full w-full object-cover"
            src="/discovery/jen.png"
          />
        </div>
      </div>
      <div className="absolute bottom-1 right-1 h-5 w-5 rounded-full border-2 border-card bg-primary shadow-sm" />
    </div>
  );
}

function RunHero({ campaign, entitlement, runState }: DiscoveryRunTabProps) {
  const { run } = runState;
  const status = run.status;
  const isRunning = runState.busy || status === "running";
  const isIdle = status === "idle" && runState.timeline.length === 0;
  const isCompleted = status === "completed" || status === "partial";
  const actionLabel = isCompleted ? "Find More Leads" : "Start Discovery";

  return (
    <Card className="flex min-h-[37.5rem] flex-col overflow-hidden rounded-2xl border-border/60 bg-card p-0 shadow-sm">
      <div
        className={
          isIdle
            ? "relative border-b border-border/50 bg-card/60 px-8 py-14"
            : "relative border-b border-border/50 bg-card/80 px-8 py-8"
        }
      >
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -left-32 -top-40 h-96 w-96 rounded-full bg-primary/10 blur-3xl" />
          <div className="absolute -bottom-40 -right-32 h-96 w-96 rounded-full bg-blue-500/10 blur-3xl" />
        </div>
        <div className="relative z-10 mx-auto w-full max-w-4xl">
          <div
            className={
              isIdle
                ? "flex flex-col items-center gap-6 text-center"
                : "flex flex-col items-start gap-6 lg:flex-row lg:gap-8"
            }
          >
            <JenAvatar isIdle={isIdle} isRunning={isRunning} />

            <div className={isIdle ? "w-full" : "min-w-0 flex-1 pt-2"}>
              <h2
                aria-label={
                  isRunning
                    ? "Discovery is running"
                    : isCompleted
                      ? "Discovery complete"
                      : "Ready to discover"
                }
                className={
                  isIdle
                    ? "font-sans text-4xl font-bold tracking-tight text-foreground"
                    : "font-sans text-3xl font-bold tracking-tight text-foreground"
                }
              >
                {isRunning
                  ? "Jen is hunting for leads..."
                  : isCompleted
                    ? "Discovery Complete!"
                    : "Ready to find your leads!"}
              </h2>
              <p
                className={
                  isIdle
                    ? "mx-auto mt-2 max-w-lg text-lg text-muted-foreground"
                    : "mt-2 max-w-lg text-sm text-muted-foreground"
                }
              >
                {isCompleted
                  ? `I found ${run.stored} new leads this session. You now have ${Math.max(campaign.leadCount, run.stored)} total leads.`
                  : isRunning
                    ? "Scanning multiple data sources in real-time to find the best matches for your campaign."
                    : terminalCopy(status)}
              </p>

              {runState.error ? (
                <p className="mt-2 text-sm text-destructive" role="alert">
                  {runState.error}
                </p>
              ) : null}

              {isIdle ? (
                <div className="mt-8 flex flex-col items-center gap-4">
                  <ActionButton
                    actionLabel="Start Discovery Engine"
                    entitlement={entitlement}
                    onRun={runState.start}
                  />
                </div>
              ) : null}

              {isCompleted ? (
                <div className="mt-6 flex flex-wrap items-center gap-3">
                  <ActionButton
                    actionLabel={actionLabel}
                    entitlement={entitlement}
                    onRun={runState.start}
                  />
                  <Button
                    className="h-12 rounded-full px-6 text-sm font-medium text-muted-foreground hover:text-foreground"
                    onClick={runState.reset}
                    size="lg"
                    type="button"
                    variant="ghost"
                  >
                    <RotateCcw aria-hidden="true" className="h-4 w-4" />
                    Start Over
                  </Button>
                </div>
              ) : null}

              {isRunning ? (
                <div className="mt-4 flex flex-wrap gap-2">
                  {run.sourceMetrics
                    .filter((metric) => metric.status === "active")
                    .map(({ source }) => (
                      <span
                        className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-card/70 px-3 py-1 text-xs font-semibold text-primary shadow-sm"
                        key={source}
                      >
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                        Scanning {DISCOVERY_SOURCE_LABELS[source]}...
                      </span>
                    ))}
                </div>
              ) : null}

              {isRunning ? (
                <Button
                  className="mt-5 rounded-full"
                  onClick={runState.cancel}
                  type="button"
                  variant="outline"
                >
                  <StopCircle aria-hidden="true" />
                  Cancel run
                </Button>
              ) : null}
            </div>

            {!isIdle ? (
              <div className="flex shrink-0 gap-3">
                <div className="min-w-28 rounded-2xl border border-border/50 bg-card/80 p-4 shadow-sm">
                  <div className="flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-primary">
                    <Target aria-hidden="true" className="h-3 w-3" />
                    New
                  </div>
                  <p className="mt-1 font-serif text-3xl leading-none tabular-nums text-foreground">
                    {run.stored}
                  </p>
                  <p className="mt-1 text-2xs text-muted-foreground">
                    this session
                  </p>
                </div>
                <div className="min-w-28 rounded-2xl border border-border/50 bg-card/60 p-4">
                  <div className="flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <Database aria-hidden="true" className="h-3 w-3" />
                    Total
                  </div>
                  <p className="mt-1 font-serif text-2xl leading-none tabular-nums text-foreground">
                    {Math.max(campaign.leadCount, run.stored)}
                  </p>
                  <p className="mt-1 text-2xs text-muted-foreground">
                    of {run.target} target
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {!isIdle ? (
        <div className="min-h-0 flex-1 bg-card/40 px-6 py-6 sm:px-8">
          <div className="mx-auto max-w-2xl">
            <DiscoveryTimeline items={runState.timeline} />
          </div>
        </div>
      ) : null}
    </Card>
  );
}

export function DiscoveryRunTab({
  campaign,
  entitlement,
  runState,
}: DiscoveryRunTabProps) {
  return (
    <div className="space-y-7">
      <div className="mb-7">
        <h1 className="font-serif text-3xl font-normal leading-none tracking-tight text-foreground">
          Discover leads for{" "}
          <em
            className="not-italic italic"
            style={{
              color:
                "color-mix(in srgb, hsl(var(--discovery-accent)) 55%, hsl(var(--foreground)) 45%)",
            }}
          >
            {campaign.roleName ?? campaign.verticalName} in {campaign.location}.
          </em>
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Jen searches configured sources, validates every result, and adds
          qualifying{" "}
          {campaign.targetType === "individual" ? "people" : "businesses"}{" "}
          straight to this campaign.
        </p>
      </div>
      <RunHero
        campaign={campaign}
        entitlement={entitlement}
        runState={runState}
      />
    </div>
  );
}
