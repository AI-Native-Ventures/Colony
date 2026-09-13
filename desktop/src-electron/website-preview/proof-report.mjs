/**
 * Crash-safe progress reporting for the real-Electron preview proof.
 *
 * The CI report step reads proof.json; a crash must never leave a 0-byte or
 * missing file. This module creates the file before any Electron work, flushes
 * it after every phase, logs one line per phase to stdout, and writes a
 * structured error record for uncaught exceptions, unhandled rejections,
 * renderer/child-process loss, and an overall watchdog before exiting
 * non-zero. All writes are synchronous so the last phase survives a process
 * death.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Schema identifier for the emitted proof record. */
export const PROOF_SCHEMA = "colony.website-preview-host-proof/1";
/** Default overall watchdog for a proof run. */
export const DEFAULT_WATCHDOG_MS = 120_000;

function errorRecord(phase, error) {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return {
    phase,
    name: normalized.name,
    message: normalized.message,
    stack: typeof normalized.stack === "string" ? normalized.stack : null,
  };
}

/**
 * Create the report. The initial `{ schema, complete: false, phase:
 * "starting" }` record is written before returning, so the file exists even
 * if the caller dies immediately after.
 */
export function createProofReport({
  directory,
  watchdogMs = DEFAULT_WATCHDOG_MS,
  log = (line) => console.log(line),
  exit = (code) => process.exit(code),
} = {}) {
  const file = path.join(directory, "proof.json");
  const state = {
    schema: PROOF_SCHEMA,
    complete: false,
    phase: "starting",
    checks: [],
    geometry: {},
    clip: { status: "unavailable", detail: null },
    notes: [],
  };
  let failed = false;
  let armed = true;

  function flush(extra = {}) {
    const payload = { ...state, ...extra };
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } catch {
      // Reporting must never mask the original failure.
    }
    return payload;
  }

  function phase(name, extra = {}) {
    state.phase = name;
    Object.assign(state, extra);
    flush();
    log(`[proof] phase ${name}`);
  }

  function update(extra = {}) {
    Object.assign(state, extra);
    return flush();
  }

  function complete() {
    if (failed) return null;
    armed = false;
    if (watchdog !== null) clearTimeout(watchdog);
    state.complete = true;
    state.phase = "complete";
    const payload = flush();
    log("[proof] complete");
    return payload;
  }

  function fail(phaseName, error) {
    if (failed || state.complete === true) return;
    failed = true;
    armed = false;
    if (watchdog !== null) clearTimeout(watchdog);
    state.phase = phaseName;
    flush({ complete: false, error: errorRecord(phaseName, error) });
    const message = error instanceof Error ? error.message : String(error);
    log(`[proof] failed in ${phaseName}: ${message}`);
  }

  function attachProcessHandlers() {
    process.on("uncaughtException", (error) => {
      fail("uncaughtException", error);
      exit(1);
    });
    process.on("unhandledRejection", (reason) => {
      fail("unhandledRejection", reason);
      exit(1);
    });
  }

  function attachAppHandlers(electronApp) {
    if (typeof electronApp?.on !== "function") return;
    electronApp.on("render-process-gone", (_event, _contents, details) => {
      fail(
        "render-process-gone",
        new Error(`renderer gone: ${details?.reason ?? "unknown"}`),
      );
      exit(1);
    });
    electronApp.on("child-process-gone", (_event, details) => {
      fail(
        "child-process-gone",
        new Error(
          `child process gone: ${details?.type ?? "unknown"} (${details?.reason ?? "unknown"})`,
        ),
      );
      exit(1);
    });
  }

  flush();
  log("[proof] phase starting");
  const watchdog = setTimeout(() => {
    if (!armed) return;
    fail("watchdog", new Error(`proof exceeded ${watchdogMs}ms`));
    exit(1);
  }, watchdogMs);

  return {
    file,
    phase,
    update,
    complete,
    fail,
    attachProcessHandlers,
    attachAppHandlers,
  };
}
