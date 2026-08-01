import { DISCOVERY_SOURCE_LABELS, type DiscoverySource } from "../sourceConfig";
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
  existingLeadIds: ReadonlySet<string>;
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

type SourceEventPayload =
  | { type: "source_started" }
  | { type: "source_progress"; progress: number; message?: string }
  | { type: "source_completed" }
  | { type: "source_exhausted" }
  | { type: "source_failed"; error: string }
  | { type: "source_skipped"; reason: string }
  | { type: "lead_stored"; lead: Lead }
  | { type: "lead_rejected"; lead: Lead; reason: string }
  | { type: "lead_duplicate"; lead: Lead; reason: string };

function sourceEvent(
  context: EventContext,
  source: DiscoverySource,
  payload: SourceEventPayload,
): DiscoveryEvent {
  const metric = metricFor(context, source);
  const snapshot = cloneMetric(metric);
  const common = {
    campaignId: context.campaign.id,
    runId: context.run.id,
    at: nextAt(context),
    run: cloneRun(context.run),
    source,
    metric: snapshot,
    sourceMetric: cloneMetric(snapshot),
  };
  switch (payload.type) {
    case "source_started":
    case "source_completed":
    case "source_exhausted":
      return { ...common, type: payload.type };
    case "source_progress":
      return { ...common, ...payload };
    case "source_failed":
    case "source_skipped":
      return { ...common, ...payload };
    case "lead_stored":
    case "lead_rejected":
    case "lead_duplicate":
      return { ...common, ...payload };
  }
}

type SessionEventPayload =
  | { type: "session_started" }
  | {
      type: "fallback_activated";
      fromSource?: DiscoverySource;
      source?: DiscoverySource;
    }
  | { type: "target_reached"; targetReached: true }
  | {
      type: "session_completed";
      targetReached: boolean;
      partial: boolean;
    }
  | { type: "session_cancelled" }
  | { type: "session_failed"; error: string };

function sessionEvent(
  context: EventContext,
  payload: SessionEventPayload,
): DiscoveryEvent {
  const common = {
    campaignId: context.campaign.id,
    runId: context.run.id,
    at: nextAt(context),
    run: cloneRun(context.run),
  };
  return { ...common, ...payload };
}

function createContext(
  campaign: CampaignDetail,
  leads: Lead[],
  scenario: FixtureScenario,
  existingLeadIds: ReadonlySet<string>,
): EventContext {
  const run = createIdleDiscoveryRun(campaign);
  run.id = `${campaign.id}-run-${scenario}`;
  run.status = "running";
  run.phase = "initializing";
  run.startedAt = "2026-08-01T09:00:00.000Z";
  return { campaign, leads, existingLeadIds, run, index: 0 };
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
  return sourceEvent(context, source, { type: "source_started" });
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
  return sourceEvent(context, source, {
    type: "source_progress",
    progress: Math.min(100, discovered * 20),
    message: `Sampled ${discovered} result${discovered === 1 ? "" : "s"}`,
  });
}

function storeLead(
  context: EventContext,
  source: DiscoverySource,
  leadOverride?: Lead,
): DiscoveryEvent {
  const metric = metricFor(context, source);
  const lead =
    leadOverride ??
    context.leads.find((item) => item.source === source) ??
    context.leads[0];
  if (!lead) throw new Error("Fixture campaign has no leads");
  if (context.existingLeadIds.has(lead.id)) {
    const metric = metricFor(context, source);
    metric.duplicates += 1;
    context.run.duplicates += 1;
    return sourceEvent(context, source, {
      type: "lead_duplicate",
      lead,
      reason: "Lead already belongs to this campaign",
    });
  }
  metric.status = "active";
  metric.stored += 1;
  context.run.stored += 1;
  return sourceEvent(context, source, { type: "lead_stored", lead });
}

function rejectLead(
  context: EventContext,
  source: DiscoverySource,
  lead: Lead,
  reason: string,
): DiscoveryEvent {
  const metric = metricFor(context, source);
  metric.rejected += 1;
  context.run.rejected += 1;
  return sourceEvent(context, source, {
    type: "lead_rejected",
    lead,
    reason,
  });
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
  return sourceEvent(context, source, { type: "source_completed" });
}

function exhaustSource(
  context: EventContext,
  source: DiscoverySource,
): DiscoveryEvent {
  const metric = metricFor(context, source);
  metric.status = "exhausted";
  metric.durationMs = metric.durationMs ?? 250;
  return sourceEvent(context, source, { type: "source_exhausted" });
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
  return sourceEvent(context, source, { type: "source_failed", error });
}

function skipSource(
  context: EventContext,
  source: DiscoverySource,
  reason: string,
): DiscoveryEvent {
  const metric = metricFor(context, source);
  metric.status = "skipped";
  metric.error = reason;
  return sourceEvent(context, source, { type: "source_skipped", reason });
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
    return sessionEvent(context, {
      type: "session_completed",
      targetReached,
      partial: status === "partial",
    });
  }
  if (status === "cancelled") {
    return sessionEvent(context, { type: "session_cancelled" });
  }
  return sessionEvent(context, {
    type: "session_failed",
    error: error ?? "Discovery failed",
  });
}

function firstSources(context: EventContext, count: number): DiscoverySource[] {
  return context.campaign.sourceConfig.order.slice(0, count);
}

function deterministicWaterfallLeads(
  context: EventContext,
  target: number,
): Lead[] {
  const template = context.leads[0];
  if (!template) throw new Error("Fixture campaign has no leads");
  return Array.from({ length: target }, (_, index) => {
    const existing = context.leads[index];
    if (existing) return existing;
    const ordinal = String(index + 1).padStart(3, "0");
    const companyName = `${template.companyName} Fixture ${ordinal}`;
    return {
      ...template,
      id: `${context.campaign.id}-fixture-lead-${ordinal}`,
      companyName,
      company: companyName,
      campaignIds: [context.campaign.id],
      addedAt: `2026-08-01T08:${String((index + 1) % 60).padStart(2, "0")}:00.000Z`,
    };
  });
}

export function createFixtureEventSequence(
  campaign: CampaignDetail,
  leads: Lead[],
  scenario: FixtureScenario,
  existingLeadIds: ReadonlySet<string> = new Set(),
): DiscoveryEvent[] {
  const context = createContext(campaign, leads, scenario, existingLeadIds);
  const events: DiscoveryEvent[] = [
    sessionEvent(context, { type: "session_started" }),
  ];
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
      if (sources[2]) events.push(exhaustSource(context, sources[2]));
      events.push(finish(context, "partial"));
      return events;
    }
    case "waterfall-target":
      events.push(startSource(context, first));
      events.push(progressSource(context, first, context.run.target));
      for (const lead of deterministicWaterfallLeads(
        context,
        context.run.target,
      )) {
        events.push(storeLead(context, first, lead));
      }
      context.run.targetReached = context.run.stored >= context.run.target;
      events.push(
        ...(context.run.targetReached
          ? [
              sessionEvent(context, {
                type: "target_reached",
                targetReached: true,
              }),
            ]
          : []),
      );
      events.push(completeSource(context, first));
      events.push(
        finish(
          context,
          context.run.targetReached ? "completed" : "partial",
          context.run.targetReached,
        ),
      );
      return events;
    case "fallback":
      events.push(startSource(context, first));
      events.push(
        failSource(
          context,
          first,
          `${DISCOVERY_SOURCE_LABELS[first]} is temporarily unavailable`,
        ),
      );
      context.run.phase = "fallback";
      events.push(
        sessionEvent(context, {
          type: "fallback_activated",
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
    case "partial": {
      events.push(startSource(context, first));
      events.push(progressSource(context, first, 2));
      events.push(storeLead(context, first));
      const rejectedLead =
        context.leads.find((lead) => lead.id !== context.leads[0]?.id) ??
        context.leads[0];
      if (rejectedLead) {
        events.push(
          rejectLead(
            context,
            first,
            rejectedLead,
            "Duplicate business profile",
          ),
        );
      }
      events.push(completeSource(context, first));
      events.push(exhaustSource(context, first));
      if (second) {
        events.push(startSource(context, second));
        events.push(progressSource(context, second, 1));
        events.push(completeSource(context, second));
      }
      events.push(finish(context, "partial"));
      return events;
    }
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
