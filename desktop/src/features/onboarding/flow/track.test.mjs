import assert from "node:assert/strict";
import test from "node:test";

import { PROBE_BUDGET_MS, resolveTrack } from "./track.ts";

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

test("probe_budget_is_eight_seconds", () => {
  assert.equal(PROBE_BUDGET_MS, 8000);
});

test("track_lists_every_brain_not_only_the_ready_ones", () => {
  // Screen 5a shows the whole set. Listing only what was found turns a picker
  // into a single row, or into nothing on a clean computer, and neither reads
  // as a choice.
  const result = resolveTrack(
    [
      {
        id: "pi",
        label: "Oh My Pi",
        availability: "available",
        authStatus: { status: "not_applicable" },
      },
      {
        id: "claude",
        label: "Claude Code",
        availability: "available",
        authStatus: { status: "logged_out" },
      },
      {
        id: "codex",
        label: "Codex",
        availability: "unavailable",
        authStatus: { status: "not_applicable" },
      },
      {
        id: "buzz-agent",
        label: "Colony agent",
        availability: "available",
        authStatus: { status: "not_applicable" },
      },
    ],
    {},
  );

  assert.deepEqual(
    result.brains,
    [
      { label: "Oh My Pi", status: "ready" },
      { label: "Claude Code", status: "needs-login" },
      { label: "Codex", status: "not-installed" },
    ],
    "every brain except Colony's own agent should be listed with its state",
  );
  assert.deepEqual(result.installed, ["Oh My Pi"]);
});
