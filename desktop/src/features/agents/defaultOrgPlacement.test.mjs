import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chiefOfStaffPubkey,
  orgPlacementForCreate,
  resolveDefaultOrgPlacement,
} from "./defaultOrgPlacement.ts";

const SCOUT = "a".repeat(64);
const OTHER = "b".repeat(64);

const personas = [
  { id: "builtin:fizz", roleId: "chief-of-staff", displayName: "Scout" },
  { id: "builtin:honey", roleId: "engineer", displayName: "Forager" },
];
const agents = [
  { pubkey: SCOUT, personaId: "builtin:fizz", name: "Scout" },
  { pubkey: OTHER, personaId: "builtin:honey", name: "Forager" },
];

test("the chief of staff is found by role id, not by name", () => {
  assert.equal(chiefOfStaffPubkey(agents, personas), SCOUT);
});

test("a renamed chief of staff is still found", () => {
  const renamed = [{ ...personas[0], displayName: "Atlas" }, personas[1]];
  assert.equal(chiefOfStaffPubkey(agents, renamed), SCOUT);
});

test("no chief of staff deployed yet resolves to nobody", () => {
  assert.equal(chiefOfStaffPubkey(agents, [personas[1]]), null);
});

test("a new agent defaults to team lead reporting to the chief of staff", () => {
  assert.deepEqual(
    resolveDefaultOrgPlacement({ roleId: "engineer", agents, personas }),
    { tier: "leader", manager: SCOUT },
  );
});

test("an agent with no role at all still gets placed", () => {
  assert.deepEqual(
    resolveDefaultOrgPlacement({ roleId: null, agents, personas }),
    { tier: "leader", manager: SCOUT },
  );
});

test("the chief of staff is an executive and reports to nobody", () => {
  assert.deepEqual(
    resolveDefaultOrgPlacement({
      roleId: "chief-of-staff",
      agents,
      personas,
    }),
    { tier: "executive", manager: null },
  );
});

test("the first agent in an empty community still gets a rank", () => {
  assert.deepEqual(
    resolveDefaultOrgPlacement({
      roleId: "engineer",
      agents: [],
      personas: [],
    }),
    { tier: "leader", manager: null },
  );
});

test("an owner's chosen placement is never overridden", () => {
  assert.deepEqual(
    orgPlacementForCreate(
      { rank: "worker", manager: OTHER },
      { tier: "leader", manager: SCOUT },
    ),
    { tier: "worker", manager: OTHER },
  );
});

test("a chosen rank without a manager is left without one", () => {
  assert.deepEqual(
    orgPlacementForCreate(
      { rank: "worker" },
      { tier: "leader", manager: SCOUT },
    ),
    { tier: "worker", manager: null },
  );
});

test("an untouched placement form falls back to the default", () => {
  assert.deepEqual(
    orgPlacementForCreate(undefined, {
      tier: "leader",
      manager: SCOUT,
    }),
    { tier: "leader", manager: SCOUT },
  );
});
