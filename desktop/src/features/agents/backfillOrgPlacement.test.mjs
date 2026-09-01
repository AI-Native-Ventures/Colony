import assert from "node:assert/strict";
import { test } from "node:test";

import { backfillLabel, planOrgBackfill } from "./backfillOrgPlacement.ts";

const SCOUT = "a".repeat(64);
const OTHER_CHIEF = "b".repeat(64);
const ENGINEER = "c".repeat(64);
const WORKER = "d".repeat(64);

const personas = [
  { id: "builtin:fizz", roleId: "chief-of-staff", displayName: "Scout" },
  { id: "p-eng", roleId: "engineer", displayName: "Anvil" },
];
const agents = [
  { pubkey: SCOUT, personaId: "builtin:fizz", name: "Chief of Staff" },
  { pubkey: ENGINEER, personaId: "p-eng", name: "Anvil - Engineer" },
  { pubkey: WORKER, personaId: "p-eng", name: "Brand Critic" },
];

test("every unplaced agent is filed under the Chief of Staff", () => {
  const plan = planOrgBackfill({
    unplaced: [
      { pubkey: ENGINEER, name: "Anvil - Engineer" },
      { pubkey: WORKER, name: "Brand Critic" },
    ],
    agents,
    personas,
  });
  assert.equal(plan.chiefOfStaff, SCOUT);
  assert.equal(plan.blockedReason, null);
  assert.deepEqual(
    plan.placements.map((p) => [p.pubkey, p.manager, p.tier]),
    [
      [ENGINEER, SCOUT, "leader"],
      [WORKER, SCOUT, "leader"],
    ],
  );
});

test("the Chief of Staff is never filed under itself", () => {
  const plan = planOrgBackfill({
    unplaced: [
      { pubkey: SCOUT, name: "Chief of Staff" },
      { pubkey: ENGINEER, name: "Anvil - Engineer" },
    ],
    agents,
    personas,
  });
  assert.deepEqual(
    plan.placements.map((p) => p.pubkey),
    [ENGINEER],
  );
});

test("a second agent on the chief-of-staff persona is also left alone", () => {
  const plan = planOrgBackfill({
    unplaced: [
      { pubkey: OTHER_CHIEF, name: "Chief of Staff (other community)" },
      { pubkey: ENGINEER, name: "Anvil - Engineer" },
    ],
    agents: [
      ...agents,
      {
        pubkey: OTHER_CHIEF,
        personaId: "builtin:fizz",
        name: "Chief of Staff",
      },
    ],
    personas,
  });
  assert.deepEqual(
    plan.placements.map((p) => p.pubkey),
    [ENGINEER],
  );
});

test("an existing rank is preserved, never promoted", () => {
  const plan = planOrgBackfill({
    unplaced: [{ pubkey: WORKER, name: "Brand Critic", rank: "worker" }],
    agents,
    personas,
  });
  assert.equal(plan.placements[0].tier, "worker");
});

test("an agent with no rank takes team lead so it can escalate", () => {
  const plan = planOrgBackfill({
    unplaced: [{ pubkey: ENGINEER, name: "Anvil", rank: null }],
    agents,
    personas,
  });
  assert.equal(plan.placements[0].tier, "leader");
});

test("no deployed Chief of Staff means no plan at all", () => {
  const plan = planOrgBackfill({
    unplaced: [{ pubkey: ENGINEER, name: "Anvil" }],
    agents: [{ pubkey: ENGINEER, personaId: "p-eng", name: "Anvil" }],
    personas: [personas[1]],
  });
  assert.deepEqual(plan, {
    placements: [],
    chiefOfStaff: null,
    blockedReason: "no-chief-of-staff",
  });
  assert.equal(backfillLabel(plan), null);
});

test("nothing to place reports itself rather than offering an empty action", () => {
  const plan = planOrgBackfill({ unplaced: [], agents, personas });
  assert.equal(plan.blockedReason, "nothing-to-place");
  assert.equal(backfillLabel(plan), null);
});

test("the label counts what will actually change", () => {
  const one = planOrgBackfill({
    unplaced: [{ pubkey: ENGINEER, name: "Anvil" }],
    agents,
    personas,
  });
  assert.equal(backfillLabel(one), "Place 1 agent under the Chief of Staff");

  const many = planOrgBackfill({
    unplaced: [
      { pubkey: ENGINEER, name: "Anvil" },
      { pubkey: WORKER, name: "Brand Critic" },
    ],
    agents,
    personas,
  });
  assert.equal(backfillLabel(many), "Place 2 agents under the Chief of Staff");
});

test("pubkeys are normalised so a mixed-case head still matches", () => {
  const plan = planOrgBackfill({
    unplaced: [{ pubkey: ENGINEER.toUpperCase(), name: "Anvil" }],
    agents,
    personas,
  });
  assert.equal(plan.placements[0].pubkey, ENGINEER);
});
