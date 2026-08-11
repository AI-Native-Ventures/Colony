/**
 * Parity session driver.
 *
 * Runs the scripted session inside the real app, against the real Rust
 * surface, and ships the artifacts to the local trace collector:
 *
 * - record: wrap the installed `NativeBridge` with the recorder
 *   (`wrapNativeBridge` + `setNativeBridge`), run every script step, settle,
 *   emit the trace (JSONL) and timing (per-command durations) to the
 *   collector;
 * - replay: restore the raw bridge, feed the freshly recorded trace back
 *   through it, and emit the structured diff report, optionally with
 *   negative-control perturbations.
 *
 * Dev-only: reachable via `?parity=record|record+replay` in the webview URL
 * or `VITE_PARITY_MODE` (see `main.tsx`). Zero presence in a normal build.
 */

import {
  getNativeBridge,
  listen,
  setNativeBridge,
} from "@/shared/api/nativeBridge";
import type { ParityRecorder } from "@/parity/recorder";
import type { ReplayReport, Perturbation } from "@/parity/replay";
import { wrapNativeBridge } from "@/parity/bridge";
import type { Trace } from "@/parity/types";
import { replayTrace } from "@/parity/replay";
import { encodeTrace } from "@/parity/types";
import {
  EVENT_NAMES,
  SESSION_STEPS,
  UNREACHABLE_EVENTS,
  scriptTable,
} from "@/parity/session/script";
import type { SessionContext } from "@/parity/session/context";
import { makeFixture } from "@/parity/session/context";

export const PARITY_COLLECTOR_URL = "http://127.0.0.1:9199";
export const PARITY_SESSION_NAME = "parity-oracle-session";
const SETTLE_MS = 10_000;

export type ParityPerturbationSpec = "result" | "error";

export type ParityDriverOptions = {
  mode: "record" | "record+replay";
  session?: string;
  relayUrl?: string;
  collectorUrl?: string;
  /** Negative-control perturbations: `result:send_channel_message` etc. */
  perturbations?: Array<{ kind: ParityPerturbationSpec; command: string }>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function perturbationFor(
  kind: ParityPerturbationSpec,
  command: string,
): Perturbation {
  if (kind === "result") {
    return {
      command,
      mutateOutcome: (outcome) => {
        if (!outcome.ok) {
          return outcome;
        }
        // Tag the result with an extra field: any drift in the result shape
        // (extra key) is a diff, and this is the most shape-agnostic mutation.
        return {
          ok: true,
          result: {
            ...(outcome.result as Record<string, unknown>),
            $perturbed: true,
          },
        };
      },
    };
  }
  return {
    command,
    mutateOutcome: (outcome) => {
      if (outcome.ok) {
        return outcome;
      }
      return {
        ok: false,
        error: { message: `${outcome.error.message} [PERTURBED]` },
      };
    },
  };
}

async function postJson(
  url: string,
  body: string,
  contentType: string,
): Promise<boolean> {
  try {
    const response = await Promise.race([
      fetch(url, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("postJson timed out")), 10_000),
      ),
    ]);
    return response.ok;
  } catch (error) {
    console.warn("[parity] collector unreachable", url, error);
    return false;
  }
}

/**
 * Fire-and-forget lifecycle beacon. `no-cors` keeps the request observable
 * from the collector even if the response is opaque to the webview — the
 * driver's progress and failures must be visible from outside the app.
 */
function beacon(collectorUrl: string, route: string, payload: unknown): void {
  try {
    void fetch(`${collectorUrl}${route}`, {
      method: "POST",
      mode: "no-cors",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Beacons are best-effort; the collector may not be running.
  }
}

/**
 * Run the scripted session. Returns the trace (and replay report when
 * requested) so the bootstrap can log a summary even without a collector.
 */
export async function runParitySession(
  options: ParityDriverOptions,
): Promise<{ trace: Trace | null; report: ReplayReport | null }> {
  const { mode, session = PARITY_SESSION_NAME } = options;
  const relayUrl = options.relayUrl ?? "ws://localhost:3000";
  const collectorUrl = options.collectorUrl ?? PARITY_COLLECTOR_URL;
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  beacon(collectorUrl, "/lifecycle", {
    phase: "start",
    session,
    runId,
    mode,
    startedAt: new Date().toISOString(),
  });
  try {
    return await runParitySessionInner(
      options,
      session,
      relayUrl,
      collectorUrl,
      runId,
    );
  } catch (error) {
    beacon(collectorUrl, "/lifecycle", {
      phase: "error",
      session,
      runId,
      mode,
      error: String(error),
      at: new Date().toISOString(),
    });
    console.error("[parity] session failed", error);
    return { trace: null, report: null };
  }
}

async function runParitySessionInner(
  options: ParityDriverOptions,
  session: string,
  relayUrl: string,
  collectorUrl: string,
  runId: string,
): Promise<{ trace: Trace | null; report: ReplayReport | null }> {
  const { mode } = options;

  // The bridge installed by `installTauriNativeBridge()` (entry point) — the
  // raw implementation replay drives. The recorder wraps it for the record
  // phase only.
  const rawBridge = getNativeBridge();

  let recorder: ParityRecorder | null = null;
  if (mode === "record" || mode === "record+replay") {
    const { ParityRecorder: Recorder } = await import("@/parity/recorder");
    recorder = new Recorder();
    setNativeBridge(wrapNativeBridge(rawBridge, recorder));
    // Event probe: register a listener for every event name AFTER the
    // recorder attached. The app's own listeners are registered at render
    // (also after attach, so they are wrapped too); the probe covers event
    // names nothing else listens for.
    await Promise.all(
      EVENT_NAMES.map((name) => listen<unknown>(name, () => {})),
    );
  }

  const ctx: SessionContext = {
    runId,
    relayWsUrl: relayUrl,
    relayHttpUrl: "http://localhost:3000",
    identityPubkey: "",
    channelId: "",
    messageId: "",
    messageCreatedAt: 0,
    workflowId: "",
    teamId: "",
    templateId: "",
    personaId: "",
    relayWsId: 0,
    relaySubId: "",
    authChallenge: "",
    duplicateTemplateId: "",
    fixture: (name) => makeFixture(runId, name),
  };

  // Give the app's own boot/community init a beat to settle so the script's
  // apply_workspace lands after any boot-time apply (the Rust command is
  // idempotent; ordering just keeps the trace deterministic).
  await sleep(3_000);

  // The session contract is the scripted session, not app boot traffic.
  recorder?.reset();

  const startedAt = performance.now();
  const STEP_TIMEOUT_MS = 45_000;
  for (const [index, step] of SESSION_STEPS.entries()) {
    const stepStartedAt = performance.now();
    try {
      const result = await Promise.race([
        step.run(ctx),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("step timed out")),
            STEP_TIMEOUT_MS,
          ),
        ),
      ]);
      step.capture?.(ctx, result);
      const stepMs = performance.now() - stepStartedAt;
      if (stepMs > 2_000) {
        console.log(
          `[parity] step ${index + 1}/${SESSION_STEPS.length} ${step.id} (${step.command}) took ${Math.round(stepMs)}ms`,
        );
        beacon(collectorUrl, "/lifecycle", {
          phase: "step",
          session,
          runId,
          index: index + 1,
          total: SESSION_STEPS.length,
          step: step.id,
          command: step.command,
          tookMs: Math.round(stepMs),
          at: new Date().toISOString(),
        });
      }
    } catch (error) {
      // Errors are part of the trace; the wrapped invoke records them.
      const stepMs = performance.now() - stepStartedAt;
      console.log(
        `[parity] step ${index + 1}/${SESSION_STEPS.length} ${step.id} (${step.command}) ${stepMs >= STEP_TIMEOUT_MS ? "TIMED OUT" : "errored"} after ${Math.round(stepMs)}ms: ${String(error).slice(0, 200)}`,
      );
      if (stepMs >= STEP_TIMEOUT_MS) {
        beacon(collectorUrl, "/lifecycle", {
          phase: "step-timeout",
          session,
          runId,
          index: index + 1,
          total: SESSION_STEPS.length,
          step: step.id,
          command: step.command,
          at: new Date().toISOString(),
        });
      }
    }
  }
  const sessionDurationMs = performance.now() - startedAt;
  beacon(collectorUrl, "/lifecycle", {
    phase: "steps-done",
    session,
    runId,
    steps: SESSION_STEPS.length,
    sessionDurationMs: Math.round(sessionDurationMs),
    at: new Date().toISOString(),
  });

  // Settle: relay pushes, workflow replies and events arrive asynchronously
  // after the last command; give the subscription path time to drain.
  await sleep(SETTLE_MS);

  let trace: Trace | null = null;
  if (recorder) {
    trace = recorder.complete({
      session,
      runId,
      recordedAt: new Date().toISOString(),
      relayUrl,
      appVersion: null,
      recordedBy: "native-bridge",
    });
    const jsonl = encodeTrace(trace);
    const delivered = await postJson(
      `${collectorUrl}/traces/${session}`,
      jsonl,
      "application/x-ndjson",
    );
    await postJson(
      `${collectorUrl}/traces/${session}.timing.json`,
      JSON.stringify(
        {
          session,
          runId,
          sessionDurationMs,
          steps: SESSION_STEPS.length,
          recordedAt: trace.header.recordedAt,
        },
        null,
        2,
      ),
      "application/json",
    );
    console.log(
      `[parity] trace ${session}: ${trace.records.length} records ` +
        `(${trace.records.filter((r) => r.kind === "command").length} commands, ` +
        `${trace.records.filter((r) => r.kind === "event").length} events, ` +
        `${trace.records.filter((r) => r.kind === "push").length} pushes), ` +
        `collector=${delivered ? "delivered" : "unreachable"}`,
    );
  }

  // Replay must drive the raw bridge: restore it so replayed traffic is
  // never re-recorded into the trace.
  setNativeBridge(rawBridge);

  let report: ReplayReport | null = null;
  if (mode === "record+replay" && trace) {
    const perturbations = (options.perturbations ?? []).map((p) =>
      perturbationFor(p.kind, p.command),
    );
    report = await replayTrace({
      trace,
      bridge: rawBridge,
      script: scriptTable(),
      perturbations,
      settleMs: SETTLE_MS,
      eventNames: [...EVENT_NAMES],
      unreachableEvents: { ...UNREACHABLE_EVENTS },
    });
    await postJson(
      `${collectorUrl}/reports/${session}`,
      JSON.stringify(report, null, 2),
      "application/json",
    );
    console.log(
      `[parity] replay ${session}: clean=${report.clean} ` +
        `(commands=${report.summary.commands}, replayed=${report.summary.replayed}, ` +
        `matched=${report.summary.matched}, diffCommands=${report.summary.diffCommands}, ` +
        `events=${report.summary.eventsRecorded}, pushes=${report.summary.pushRecorded}), ` +
        `perturbations=${report.perturbations.join(",") || "none"}`,
    );
    beacon(collectorUrl, "/lifecycle", {
      phase: "replay",
      session,
      runId,
      mode,
      clean: report.clean,
      summary: report.summary,
      timing: report.timing,
      at: new Date().toISOString(),
    });
  } else {
    beacon(collectorUrl, "/lifecycle", {
      phase: "recorded",
      session,
      runId,
      mode,
      traceRecords: trace?.records.length ?? 0,
      at: new Date().toISOString(),
    });
  }

  return { trace, report };
}
