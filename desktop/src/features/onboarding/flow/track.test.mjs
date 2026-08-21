import assert from "node:assert/strict";
import test from "node:test";

import { PROBE_BUDGET_MS, resolveTrack, withProbeBudget } from "./track.ts";

function runtime(overrides = {}) {
  return {
    id: "claude-code",
    label: "Claude Code",
    availability: "available",
    authStatus: { status: "logged_in" },
    avatarUrl: "",
    command: "claude",
    binaryPath: "/usr/local/bin/claude",
    defaultArgs: [],
    mcpCommand: null,
    installHint: "",
    installInstructionsUrl: "https://example.com",
    canAutoInstall: false,
    underlyingCliPath: null,
    nodeRequired: false,
    loginHint: null,
    ...overrides,
  };
}

const emptyConfig = { agents: {}, defaults: {} };

test("track_is_byo_when_a_logged_in_runtime_exists", () => {
  const result = resolveTrack([runtime()], emptyConfig);
  assert.equal(result.track, "byo");
  assert.deepEqual(result.installed, ["Claude Code"]);
});

test("track_is_colony_when_nothing_is_available", () => {
  const result = resolveTrack(
    [runtime({ availability: "missing" })],
    emptyConfig,
  );
  assert.equal(result.track, "colony");
  assert.deepEqual(result.installed, []);
});

test("track_ignores_a_runtime_that_is_present_but_not_logged_in", () => {
  // Installed but unusable is the same as absent for a non-technical user:
  // we must not offer a brain that cannot answer.
  const result = resolveTrack(
    [runtime({ authStatus: { status: "logged_out" } })],
    emptyConfig,
  );
  assert.equal(result.track, "colony");
});

test("probe_budget_falls_back_when_the_probe_hangs", async () => {
  const hang = new Promise(() => {});
  const result = await withProbeBudget(hang, 20, "fallback");
  assert.equal(result, "fallback");
});

test("probe_budget_returns_the_real_value_when_it_arrives_in_time", async () => {
  const result = await withProbeBudget(Promise.resolve("real"), 50, "fallback");
  assert.equal(result, "real");
});

test("probe_budget_is_eight_seconds", () => {
  assert.equal(PROBE_BUDGET_MS, 8000);
});
