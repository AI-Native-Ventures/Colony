import type { DiscoverySource } from "../sourceConfig";
import type { DiscoveryEvent } from "../types";
import {
  type CampaignProjection,
  eventBase,
  type RunSourceProjection,
  sourceMetric,
} from "./relayDiscoveryModels";

export function sourceFingerprint(source: RunSourceProjection): string {
  return [
    source.status,
    source.request_count,
    source.returned_count,
    source.retained_count,
    source.duplicate_count,
    source.failure_class ?? "",
    source.updated_at,
  ].join(":");
}

export function sourceEvents(
  previous: Map<DiscoverySource, string>,
  campaign: CampaignProjection,
): DiscoveryEvent[] {
  const events: DiscoveryEvent[] = [];
  const base = eventBase(campaign);
  for (const source of campaign.latest_run_sources ?? []) {
    const fingerprint = sourceFingerprint(source);
    const prior = previous.get(source.source);
    if (prior === fingerprint) continue;
    previous.set(source.source, fingerprint);
    const metric = sourceMetric(source);
    if (source.status === "active" && !prior?.startsWith("active:")) {
      events.push({
        type: "source_started",
        source: source.source,
        metric,
        sourceMetric: metric,
        ...base,
      });
    }
    if (source.status === "active") {
      events.push({
        type: "source_progress",
        source: source.source,
        metric,
        sourceMetric: metric,
        progress: base.run.completion,
        message: `${metric.discovered} returned · ${metric.stored} new · ${metric.duplicates} existing`,
        ...base,
      });
    } else if (source.status === "completed") {
      events.push({
        type: "source_completed",
        source: source.source,
        metric,
        sourceMetric: metric,
        ...base,
      });
    } else if (source.status === "exhausted" || source.status === "cancelled") {
      events.push({
        type: "source_exhausted",
        source: source.source,
        metric,
        sourceMetric: metric,
        ...base,
      });
    } else if (
      source.status === "failed" ||
      source.status === "outcome_unknown"
    ) {
      events.push({
        type: "source_failed",
        source: source.source,
        metric,
        sourceMetric: metric,
        error: metric.error ?? "The source failed.",
        ...base,
      });
    } else if (source.status === "skipped_target_met") {
      events.push({
        type: "source_skipped",
        source: source.source,
        metric,
        sourceMetric: metric,
        reason: "The campaign target was already reached.",
        ...base,
      });
    }
  }
  return events;
}
