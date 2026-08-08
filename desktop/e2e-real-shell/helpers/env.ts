// Shared environment contract for the real-shell E2E harness. The
// orchestrator (scripts/run-real-shell-e2e.sh) sets these; defaults keep the
// suite runnable from a plain `pnpm harness:test` against the local relay.
export const RELAY_WS_URL =
  process.env.BUZZ_E2E_RELAY_URL ?? "ws://localhost:3030";
export const RELAY_HTTP_URL = RELAY_WS_URL.replace(/^ws/, "http");

// Where flow 02 records the created identity so flow 03 can prove restore.
export const IDENTITY_STATE_PATH =
  process.env.BUZZ_REAL_SHELL_IDENTITY_STATE ??
  "/tmp/buzz-real-shell-identity.json";

// Per-flow result records, printed loudly by the orchestrator at the end.
export const RESULTS_PATH =
  process.env.BUZZ_REAL_SHELL_RESULTS ??
  "e2e-real-shell/results/flow-results.jsonl";
