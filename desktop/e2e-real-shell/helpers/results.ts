// Per-flow result ledger. Each spec appends one line; the orchestrator prints
// the whole ledger at the end so PASS / FAIL / SKIP are never silent.
import { appendFileSync } from "node:fs";
import { RESULTS_PATH } from "./env";

export type FlowStatus = "pass" | "fail" | "skip";

export function recordResult(flow: string, status: FlowStatus, detail = "") {
  const line = JSON.stringify({
    flow,
    status,
    detail,
    at: new Date().toISOString(),
  });
  appendFileSync(RESULTS_PATH, `${line}\n`);
  const banner =
    status === "skip"
      ? `[REAL-SHELL SKIP] ${flow}: ${detail}`
      : `[REAL-SHELL ${status.toUpperCase()}] ${flow}${detail ? `: ${detail}` : ""}`;
  // eslint-disable-next-line no-console
  console.log(`\n${"=".repeat(80)}\n${banner}\n${"=".repeat(80)}\n`);
}

// Record a loud skip and stop the test without failing the suite. Must be
// called with mocha's `this` (non-arrow test function).
export function skipFlow(
  this: Mocha.Context,
  flow: string,
  reason: string,
): never {
  recordResult(flow, "skip", reason);
  return this.skip();
}
