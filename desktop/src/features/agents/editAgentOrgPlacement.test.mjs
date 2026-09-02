import assert from "node:assert/strict";
import { test } from "node:test";

import {
  orgPlacementChanged,
  seedOrgPlacement,
} from "./editAgentOrgPlacement.ts";

const AGENT =
  "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66";
const MANAGER =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const STRANGER =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function member(overrides = {}) {
  return {
    pubkey: AGENT,
    name: "Scout",
    role: "researcher",
    rank: "worker",
    manager: MANAGER,
    isPersonalAgent: true,
    ...overrides,
  };
}

test("seed_uses_the_members_rank_and_manager", () => {
  const seeded = seedOrgPlacement([member()], AGENT);
  assert.deepEqual(seeded, {
    rank: "worker",
    manager: MANAGER,
    known: true,
    isPersonalAgent: true,
  });
});

test("seed_falls_back_to_leader_when_the_agent_is_unknown", () => {
  const seeded = seedOrgPlacement([member({ pubkey: STRANGER })], AGENT);
  assert.equal(seeded.known, false);
  assert.equal(seeded.rank, "leader");
  assert.equal(seeded.manager, "");
  // An agent with no chart row has no employee row either, so its placement
  // can only ever be published onto its own managed-agent head.
  assert.equal(seeded.isPersonalAgent, true);
});

test("seed_reads_null_manager_as_empty_string", () => {
  const seeded = seedOrgPlacement([member({ manager: null })], AGENT);
  assert.equal(seeded.manager, "");
  assert.equal(seeded.known, true);
});

test("seed_matches_the_pubkey_case_insensitively", () => {
  const seeded = seedOrgPlacement([member()], AGENT.toUpperCase());
  assert.equal(seeded.known, true);
  assert.equal(seeded.rank, "worker");
});

test("seed_keeps_an_employee_off_the_managed_agent_head_path", () => {
  const seeded = seedOrgPlacement(
    [member({ isPersonalAgent: false, rank: "leader", manager: null })],
    AGENT,
  );
  assert.equal(seeded.isPersonalAgent, false);
  assert.equal(seeded.rank, "leader");
});

test("changed_is_false_for_identical_values", () => {
  assert.equal(
    orgPlacementChanged(
      { rank: "worker", manager: MANAGER },
      { rank: "worker", manager: MANAGER },
    ),
    false,
  );
});

test("changed_is_true_when_only_manager_differs", () => {
  assert.equal(
    orgPlacementChanged(
      { rank: "worker", manager: MANAGER },
      { rank: "worker", manager: "" },
    ),
    true,
  );
});

test("changed_is_true_when_only_rank_differs", () => {
  assert.equal(
    orgPlacementChanged(
      { rank: "worker", manager: MANAGER },
      { rank: "leader", manager: MANAGER },
    ),
    true,
  );
});
