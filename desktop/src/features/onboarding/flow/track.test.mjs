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

test("track_lists_every_brain_ready_ones_first", () => {
  // Screen 5a shows the whole set. Listing only what was found turns a picker
  // into a single row, or into nothing on a clean computer, and neither reads
  // as a choice.
  //
  // Two things this pins beyond that. Colony's own agent is in the list: it
  // is hosted, so it is the one option that works on a computer with nothing
  // installed, and leaving it out meant that computer reached this screen
  // with no usable choice on it. And the list is ordered by state, because a
  // dozen tools in catalog order buried the two someone could actually use
  // among the ones they cannot.
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
      { label: "Colony agent", status: "ready" },
      { label: "Oh My Pi", status: "ready" },
      { label: "Claude Code", status: "needs-login" },
      { label: "Codex", status: "not-installed" },
    ],
    "every brain listed with its state, usable ones first",
  );
  assert.deepEqual(result.installed, ["Oh My Pi"]);
});

test("track_lists_colony_agent_even_on_a_bare_computer", () => {
  // The case that made this necessary: nothing installed, so without the
  // hosted agent the screen offers a list of things you cannot use and no way
  // forward.
  const result = resolveTrack([], {});
  assert.deepEqual(result.brains, [{ label: "Colony Agent", status: "ready" }]);
  assert.equal(result.track, "colony");
});

test("track_orders_ready_then_needs_login_then_absent", () => {
  const result = resolveTrack(
    [
      {
        id: "absent",
        label: "Devin",
        availability: "unavailable",
        authStatus: { status: "not_applicable" },
      },
      {
        id: "signed-out",
        label: "Cursor",
        availability: "available",
        authStatus: { status: "logged_out" },
      },
      {
        id: "usable",
        label: "Goose",
        availability: "available",
        authStatus: { status: "logged_in" },
      },
    ],
    {},
  );
  assert.deepEqual(
    result.brains.map((brain) => brain.status),
    ["ready", "ready", "needs-login", "not-installed"],
  );
  // Catalog order is preserved inside each group, so the list does not
  // reshuffle between renders.
  assert.deepEqual(
    result.brains.map((brain) => brain.label),
    ["Colony Agent", "Goose", "Cursor", "Devin"],
  );
});
