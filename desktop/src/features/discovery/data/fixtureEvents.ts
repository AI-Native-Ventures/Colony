import type { DiscoverySource } from "../sourceConfig";
import type {
  CampaignDetail,
  DiscoveryEvent,
  DiscoveryRun,
  Lead,
  SourceMetric,
} from "../types";
import { createIdleDiscoveryRun } from "./fixtures";

export const FIXTURE_SCENARIOS = [
  "concurrent",
  "waterfall-target",
  "fallback",
  "skipped-source",
  "partial",
  "cancelled",
  "failed",
] as const;

export type FixtureScenario = (typeof FIXTURE_SCENARIOS)[number];

const EVENT_ORIGIN = Date.parse("2026-08-01T09:00:00.000Z");

type EventContext = {
  campaign: CampaignDetail;
  leads: Lead[];
  run: DiscoveryRun;
  index: number;
};

function cloneMetric(metric: SourceMetric): SourceMetric {
  return { ...metric };
}

function cloneRun(run: DiscoveryRun): DiscoveryRun {
  return {
    ...run,
    sourceMetrics: run.sourceMetrics.map(cloneMetric),
  };
}

function nextAt(context: EventContext): string {
  const at = new Date(EVENT_ORIGIN + context.index * 1000).toISOString();
  context.index += 1;
  return at;
}

function metricFor(
  context: EventContext,
  source: DiscoverySource,
): SourceMetric {
  const metric = context.run.sourceMetrics.find(
    (item) => item.source === source,
  );
  if (!metric) {
    throw new Error(
      `Fixture source ${source} is not configured for ${context.campaign.id}`,
    );
  }
  return metric;
}

function sourceEvent(
  context: EventContext,
  type:
    | "source_started"
    | "source_progress"
    | "source_completed"
    | "source_exhausted"
    | "source_failed"
    | "source_skipped"
    | "lead_stored"
    | "lead_rejected",
  source: DiscoverySource,
  extra: Record<string, unknown> = {},
): DiscoveryEvent {
  const metric = metricFor(context, source);
  const snapshot = cloneMetric(metric);
  return {
    type,
    campaignId: context.campaign.id,
    runId: context.run.id,
    at: nextAt(context),
    run: cloneRun(context.run),
    source,
    metric: snapshot,
    sourceMetric: cloneMetric(snapshot),
    ...extra,
  } as DiscoveryEvent;
}

function sessionEvent(
  context: EventContext,
  type:
    | "session_started"
    | "fallback_activated"
    | "target_reached"
    | "session_completed"
    | "session_cancelled"
    | "session_failed",
  extra: Record<string, unknown> = {},
): DiscoveryEvent {
  return {
    type,
    campaignId: context.campaign.id,
    runId: context.run.id,
    at: nextAt(context),
    run: cloneRun(context.run),
    ...extra,
  } as DiscoveryEvent;
}

function createContext(
  campaign: CampaignDetail,
  leads: Lead[],
  scenario: FixtureScenario,
): EventContext {
  const run = createIdleDiscoveryRun(campaign);
  run.id = `${campaign.id}-run-${scenario}`;
  run.status = "running";
  run.phase = "initializing";
  run.startedAt = "2026-08-01T09:00:00.000Z";
  return { campaign, leads, run, index: 0 };
}

function setCurrentSource(
  context: EventContext,
  source?: DiscoverySource,
): void {
  context.run.currentSource = source;
  context.run.phase = source ? "focused_discovery" : context.run.phase;
}

function startSource(
  context: EventContext,
  source: DiscoverySource,
): DiscoveryEvent {
  const metric = metricFor(context, source);
  metric.status = "active";
  setCurrentSource(context, source);
  return sourceEvent(context, "source_started", source);
}

function progressSource(
  context: EventContext,
  source: DiscoverySource,
  discovered: number,
): DiscoveryEvent {
  const metric = metricFor(context, source);
  metric.status = "sampling";
  metric.discovered = discovered;
  metric.quality = Math.min(100, 70 + discovered * 5);
  metric.acceptance = discovered ? 100 : 0;
  context.run.phase = "sampling";
  context.run.discovered += discovered;
  return sourceEvent(context, "source_progress", source, {
    progress: Math.min(100, discovered * 20),
    message: `Sampled ${discovered} result${discovered === 1 ? "" : "s"}`,
  });
}

function storeLead(
  context: EventContext,
  source: DiscoverySource,
): DiscoveryEvent {
  const metric = metricFor(context, source);
  const lead =
    context.leads.find((item) => item.source === source) ?? context.leads[0];
  if (!lead) throw new Error("Fixture campaign has no leads");
  metric.status = "active";
  metric.stored += 1;
  context.run.stored += 1;
  return sourceEvent(context, "lead_stored", source, { lead });
}

function completeSource(
  context: EventContext,
  source: DiscoverySource,
): DiscoveryEvent {
  const metric = metricFor(context, source);
  metric.status = "exhausted";
  metric.durationMs = 250;
  metric.acceptance = metric.discovered
    ? Math.round((metric.stored / metric.discovered) * 100)
    : 0;
  return sourceEvent(context, "source_completed", source);
}

function failSource(
  context: EventContext,
  source: DiscoverySource,
  error: string,
): DiscoveryEvent {
  const metric = metricFor(context, source);
  metric.status = "failed";
  metric.error = error;
  metric.durationMs = 120;
  context.run.phase = "evaluating";
  return sourceEvent(context, "source_failed", source, { error });
}

function skipSource(
  context: EventContext,
  source: DiscoverySource,
  reason: string,
): DiscoveryEvent {
  const metric = metricFor(context, source);
  metric.status = "skipped";
  metric.error = reason;
  return sourceEvent(context, "source_skipped", source, { reason });
}

function finish(
  context: EventContext,
  status: "completed" | "partial" | "cancelled" | "failed",
  targetReached = false,
  error?: string,
): DiscoveryEvent {
  context.run.status = status;
  context.run.phase = status === "failed" ? "failed" : "completed";
  context.run.targetReached = targetReached;
  context.run.completion = targetReached
    ? 100
    : Math.min(
        100,
        Math.round((context.run.stored / context.run.target) * 100),
      );
  context.run.completedAt = new Date(
    EVENT_ORIGIN + context.index * 1000,
  ).toISOString();
  if (error) context.run.error = error;
  if (status === "completed" || status === "partial") {
    return sessionEvent(context, "session_completed", {
      targetReached,
      partial: status === "partial",
    });
  }
  if (status === "cancelled") {
    return sessionEvent(context, "session_cancelled");
  }
  return sessionEvent(context, "session_failed", {
    error: error ?? "Discovery failed",
  });
}

function firstSources(context: EventContext, count: number): DiscoverySource[] {
  return context.campaign.sourceConfig.order.slice(0, count);
}

export function createFixtureEventSequence(
  campaign: CampaignDetail,
  leads: Lead[],
  scenario: FixtureScenario,
): DiscoveryEvent[] {
  const context = createContext(campaign, leads, scenario);
  const events: DiscoveryEvent[] = [sessionEvent(context, "session_started")];
  const [first, second, third] = firstSources(context, 3);

  if (!first) return [...events, finish(context, "partial")];

  switch (scenario) {
    case "concurrent": {
      const sources = [first, second, third].filter(
        (source): source is DiscoverySource => source !== undefined,
      );
      for (const source of sources) events.push(startSource(context, source));
      for (const source of sources) {
        events.push(progressSource(context, source, 1));
        events.push(storeLead(context, source));
      }
      for (const source of sources)
        events.push(completeSource(context, source));
      events.push(finish(context, "partial"));
      return events;
    }
    case "waterfall-target":
      events.push(startSource(context, first));
      events.push(progressSource(context, first, 10));
      events.push(storeLead(context, first));
      context.run.stored = context.run.target;
      events.push(
        sessionEvent(context, "target_reached", { targetReached: true }),
      );
      events.push(completeSource(context, first));
      events.push(finish(context, "completed", true));
      return events;
    case "fallback":
      events.push(startSource(context, first));
      events.push(
        failSource(
          context,
          first,
          "Google Maps quota is temporarily unavailable",
        ),
      );
      context.run.phase = "fallback";
      events.push(
        sessionEvent(context, "fallback_activated", {
          fromSource: first,
          source: second,
        }),
      );
      if (second) {
        events.push(startSource(context, second));
        events.push(progressSource(context, second, 2));
        events.push(storeLead(context, second));
        events.push(completeSource(context, second));
      }
      events.push(finish(context, "completed"));
      return events;
    case "skipped-source":
      events.push(
        skipSource(context, first, "Source disabled by campaign configuration"),
      );
      if (second) {
        events.push(startSource(context, second));
        events.push(progressSource(context, second, 2));
        events.push(storeLead(context, second));
        events.push(completeSource(context, second));
      }
      events.push(finish(context, "completed"));
      return events;
    case "partial":
      events.push(startSource(context, first));
      events.push(progressSource(context, first, 1));
      events.push(storeLead(context, first));
      events.push(completeSource(context, first));
      if (second) {
        events.push(startSource(context, second));
        events.push(progressSource(context, second, 1));
        events.push(completeSource(context, second));
      }
      events.push(finish(context, "partial"));
      return events;
    case "cancelled":
      events.push(startSource(context, first));
      events.push(progressSource(context, first, 1));
      events.push(finish(context, "cancelled"));
      return events;
    case "failed":
      events.push(startSource(context, first));
      events.push(
        failSource(context, first, "Provider returned an unavailable response"),
      );
      events.push(
        finish(
          context,
          "failed",
          false,
          "Discovery failed while contacting a source",
        ),
      );
      return events;
  }
}

export const createFixtureEvents = createFixtureEventSequence;
