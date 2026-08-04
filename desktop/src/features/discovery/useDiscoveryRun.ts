import * as React from "react";

import { canStartDiscovery, type DiscoveryEntitlement } from "./entitlement";
import type { DiscoveryDataSource } from "./data/DiscoveryDataSource";
import type { DiscoverySource } from "./sourceConfig";
import type {
  CampaignDetail,
  DiscoveryEvent,
  DiscoveryRun,
  DiscoveryRunStatus,
  SourceMetric,
} from "./types";

export type DiscoveryTimelineItem = {
  id: string;
  at: string;
  type: DiscoveryEvent["type"];
  source?: DiscoverySource;
  message: string;
  tone: "neutral" | "success" | "warning" | "danger" | "info";
};

export type DiscoveryRunState = {
  run: DiscoveryRun;
  runId: string | null;
  timeline: DiscoveryTimelineItem[];
  terminal: boolean;
};

export type DiscoveryRunAction =
  | { type: "reset"; run: DiscoveryRun }
  | { type: "event"; event: DiscoveryEvent };

const TERMINAL_STATUSES = new Set<DiscoveryRunStatus>([
  "completed",
  "partial",
  "cancelled",
  "failed",
]);

export function isTerminalDiscoveryEvent(event: DiscoveryEvent): boolean {
  return (
    event.type === "session_completed" ||
    event.type === "session_cancelled" ||
    event.type === "session_failed"
  );
}

export function isTerminalDiscoveryRun(run: DiscoveryRun): boolean {
  return TERMINAL_STATUSES.has(run.status);
}

function cloneMetric(metric: SourceMetric): SourceMetric {
  return { ...metric };
}

function cloneRun(run: DiscoveryRun): DiscoveryRun {
  return {
    ...run,
    sourceMetrics: run.sourceMetrics.map(cloneMetric),
  };
}

export function createDiscoveryRunState(run: DiscoveryRun): DiscoveryRunState {
  const normalized = cloneRun(run);
  return {
    run: normalized,
    runId: null,
    terminal: isTerminalDiscoveryRun(normalized),
    timeline: [],
  };
}

function sourceLabel(event: DiscoveryEvent): DiscoverySource | undefined {
  switch (event.type) {
    case "source_started":
    case "source_progress":
    case "source_completed":
    case "source_exhausted":
    case "source_failed":
    case "source_skipped":
    case "lead_stored":
    case "lead_rejected":
    case "lead_duplicate":
      return event.source;
    case "fallback_activated":
      return event.source;
    default:
      return undefined;
  }
}

function sourceMetricForEvent(event: DiscoveryEvent): SourceMetric | undefined {
  switch (event.type) {
    case "source_started":
    case "source_progress":
    case "source_completed":
    case "source_exhausted":
    case "source_failed":
    case "source_skipped":
    case "lead_stored":
    case "lead_rejected":
    case "lead_duplicate":
      return event.sourceMetric;
    default:
      return undefined;
  }
}

function eventMessage(event: DiscoveryEvent): {
  message: string;
  tone: DiscoveryTimelineItem["tone"];
} {
  const source = sourceLabel(event);
  const label = source ? source.replaceAll("_", " ") : "Discovery";
  switch (event.type) {
    case "session_started":
      return { message: "Discovery session started", tone: "info" };
    case "source_started":
      return { message: `${label} is now active`, tone: "info" };
    case "source_progress":
      return {
        message: `${label}: ${event.message ?? `${event.progress}% complete`}`,
        tone: "neutral",
      };
    case "source_completed":
      return { message: `${label} completed`, tone: "success" };
    case "source_exhausted":
      return { message: `${label} is exhausted`, tone: "neutral" };
    case "source_failed":
      return { message: `${label} failed: ${event.error}`, tone: "danger" };
    case "source_skipped":
      return { message: `${label} skipped: ${event.reason}`, tone: "warning" };
    case "fallback_activated":
      return {
        message: `Fallback activated${event.source ? ` with ${event.source.replaceAll("_", " ")}` : ""}`,
        tone: "warning",
      };
    case "lead_stored":
      return { message: `Stored ${event.lead.companyName}`, tone: "success" };
    case "lead_rejected":
      return { message: `Rejected lead: ${event.reason}`, tone: "warning" };
    case "lead_duplicate":
      return { message: `Duplicate lead: ${event.reason}`, tone: "warning" };
    case "target_reached":
      return {
        message: `Target reached: ${event.run.target} leads`,
        tone: "success",
      };
    case "session_completed":
      return {
        message: event.partial
          ? "Discovery completed with partial results"
          : "Discovery completed",
        tone: event.partial ? "warning" : "success",
      };
    case "session_cancelled":
      return { message: "Discovery was cancelled", tone: "warning" };
    case "session_failed":
      return { message: event.error, tone: "danger" };
  }
}

export function discoveryTimelineItem(
  event: DiscoveryEvent,
  index: number,
): DiscoveryTimelineItem {
  const { message, tone } = eventMessage(event);
  return {
    id: `${event.runId}:${event.at}:${event.type}:${index}`,
    at: event.at,
    type: event.type,
    source: sourceLabel(event),
    message,
    tone,
  };
}

function mergeEventRun(
  current: DiscoveryRun,
  event: DiscoveryEvent,
): DiscoveryRun {
  const incoming = cloneRun(event.run);
  const eventSourceMetric = sourceMetricForEvent(event);
  const incomingMetrics = incoming.sourceMetrics.map(cloneMetric);
  if (eventSourceMetric) {
    const index = incomingMetrics.findIndex(
      (metric) => metric.source === eventSourceMetric.source,
    );
    if (index >= 0) incomingMetrics[index] = cloneMetric(eventSourceMetric);
    else incomingMetrics.push(cloneMetric(eventSourceMetric));
  }

  return {
    ...current,
    ...incoming,
    sourceMetrics: incomingMetrics,
  };
}

export function discoveryRunReducer(
  state: DiscoveryRunState,
  action: DiscoveryRunAction,
): DiscoveryRunState {
  if (action.type === "reset") return createDiscoveryRunState(action.run);
  if (state.terminal) return state;

  const { event } = action;
  if (state.runId && state.runId !== event.runId) return state;

  const run = mergeEventRun(state.run, event);
  const terminal =
    isTerminalDiscoveryEvent(event) || isTerminalDiscoveryRun(run);
  return {
    run,
    runId: state.runId ?? event.runId,
    terminal,
    timeline: [
      ...state.timeline,
      discoveryTimelineItem(event, state.timeline.length),
    ],
  };
}

function createInitialRun(campaign: CampaignDetail): DiscoveryRun {
  if (campaign.run) return cloneRun(campaign.run);
  return createIdleRun(campaign);
}

/** Reset starts a fresh local session even when the adapter persisted a prior terminal run. */
function createIdleRun(campaign: CampaignDetail): DiscoveryRun {
  return {
    id: `${campaign.id}-run-0001`,
    campaignId: campaign.id,
    status: "idle",
    phase: "initializing",
    target: campaign.target,
    discovered: 0,
    stored: 0,
    rejected: 0,
    duplicates: 0,
    completion: 0,
    targetReached: false,
    sourceMetrics: campaign.sourceConfig.order.map((source) => ({
      source,
      status: "pending",
      discovered: 0,
      stored: 0,
      rejected: 0,
      duplicates: 0,
      quality: 0,
      acceptance: 0,
    })),
  };
}

export type UseDiscoveryRunResult = DiscoveryRunState & {
  busy: boolean;
  error: string | null;
  canStart: boolean;
  start: () => void;
  retry: () => void;
  cancel: () => void;
  reset: () => void;
};

export function useDiscoveryRun(
  campaign: CampaignDetail,
  dataSource: DiscoveryDataSource,
  entitlement: DiscoveryEntitlement | null,
): UseDiscoveryRunResult {
  const campaignId = campaign.id;
  const initialRun = React.useMemo(
    () => createInitialRun(campaign),
    [campaign],
  );
  const [state, dispatch] = React.useReducer(
    discoveryRunReducer,
    initialRun,
    createDiscoveryRunState,
  );
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const generation = React.useRef(0);

  React.useEffect(() => {
    generation.current += 1;
    dispatch({ type: "reset", run: initialRun });
    setBusy(false);
    setError(null);
  }, [initialRun]);

  const consume = React.useCallback(
    async (stream: AsyncIterable<DiscoveryEvent>, token: number) => {
      try {
        for await (const event of stream) {
          if (generation.current !== token) return;
          dispatch({ type: "event", event });
          if (isTerminalDiscoveryEvent(event)) {
            setBusy(false);
            return;
          }
        }
        if (generation.current === token) setBusy(false);
      } catch (cause: unknown) {
        if (generation.current !== token) return;
        setBusy(false);
        setError(cause instanceof Error ? cause.message : "Discovery failed");
      }
    },
    [],
  );

  const startStream = React.useCallback(
    (mode: "start" | "retry") => {
      if (!canStartDiscovery({ state: entitlement?.state ?? "loading" })) {
        setError(
          entitlement?.state === "error"
            ? "Discovery access could not be confirmed."
            : "Discovery access is required to run discovery.",
        );
        return;
      }
      generation.current += 1;
      const token = generation.current;
      // Every explicit start/retry is a fresh local session. Reusing a
      // persisted terminal run would make the reducer terminal before the
      // relay can deliver the new run's first event.
      dispatch({ type: "reset", run: createIdleRun(campaign) });
      setBusy(true);
      setError(null);
      const stream =
        mode === "retry"
          ? dataSource.retryDiscovery(campaignId)
          : dataSource.startDiscovery(campaignId);
      void consume(stream, token);
    },
    [campaign, campaignId, consume, dataSource, entitlement?.state],
  );

  const cancel = React.useCallback(() => {
    if (!busy) return;
    const token = generation.current;
    void dataSource.cancelDiscovery(campaignId).catch((cause: unknown) => {
      if (generation.current !== token) return;
      setError(
        cause instanceof Error ? cause.message : "Could not cancel discovery",
      );
    });
  }, [busy, campaignId, dataSource]);

  const reset = React.useCallback(() => {
    generation.current += 1;
    dispatch({ type: "reset", run: createIdleRun(campaign) });
    setBusy(false);
    setError(null);
  }, [campaign]);

  return {
    ...state,
    busy,
    error,
    canStart: canStartDiscovery({ state: entitlement?.state ?? "loading" }),
    start: () => startStream("start"),
    retry: () => startStream("retry"),
    cancel,
    reset,
  };
}
