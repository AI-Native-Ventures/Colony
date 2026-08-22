import assert from "node:assert/strict";
import { test } from "node:test";

import { orgMembersFromSources } from "./orgMembers.ts";

const AGENT =
  "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66";
const OTHER_AGENT =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EMPLOYEE =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function employeeHead(overrides = {}) {
  return {
    pubkey: EMPLOYEE,
    role: "chief-of-staff",
    name: "Mint",
    rank: "executive",
    manager: null,
    ...overrides,
  };
}

function managedHead(overrides = {}) {
  return {
    pubkey: AGENT,
    name: "Scout",
    roleId: null,
    tierRank: null,
    manager: null,
    ...overrides,
  };
}

test("a personal agent with no rank lands in the unranked group, not the chart", () => {
  const { members, unrankedAgents } = orgMembersFromSources(
    [employeeHead()],
    [managedHead()],
  );
  assert.equal(members.length, 1);
  assert.equal(members[0]?.pubkey, EMPLOYEE);
  assert.deepEqual(unrankedAgents, [
    { pubkey: AGENT, name: "Scout", role: "" },
  ]);
});

test("an unranked agent without a display name falls back to a truncated pubkey", () => {
  const { unrankedAgents } = orgMembersFromSources(
    [],
    [managedHead({ name: null })],
  );
  assert.equal(unrankedAgents.length, 1);
  assert.match(unrankedAgents[0]?.name ?? "", /aa11bb22/);
  assert.notEqual(unrankedAgents[0]?.name, AGENT);
});

test("ranking the agent moves it onto the chart as a personal agent", () => {
  const { members, unrankedAgents } = orgMembersFromSources(
    [],
    [managedHead({ tierRank: "worker" })],
  );
  assert.equal(unrankedAgents.length, 0);
  assert.equal(members.length, 1);
  assert.equal(members[0]?.pubkey, AGENT);
  assert.equal(members[0]?.rank, "worker");
  assert.equal(members[0]?.isPersonalAgent, true);
});

test("a self-authored head yields nothing at all: no chart row, no unranked entry", () => {
  // trustedManagedAgentHeads drops non-owner-authored heads before this
  // projection runs; an empty owner set stands in for that scan here.
  const { members, unrankedAgents } = orgMembersFromSources([], []);
  assert.equal(members.length, 0);
  assert.equal(unrankedAgents.length, 0);
});

test("an employee row keeps precedence over a head at the same pubkey", () => {
  const { members, unrankedAgents } = orgMembersFromSources(
    [employeeHead()],
    [managedHead({ pubkey: EMPLOYEE, tierRank: "worker" })],
  );
  assert.equal(unrankedAgents.length, 0);
  assert.equal(members.length, 1);
  assert.equal(members[0]?.isPersonalAgent, false);
  assert.equal(members[0]?.rank, "executive");
});

test("a head whose role resolves to a filled employee takes the employee's rank", () => {
  const { members, unrankedAgents } = orgMembersFromSources(
    [employeeHead()],
    [managedHead({ roleId: "chief-of-staff", tierRank: null })],
  );
  assert.equal(unrankedAgents.length, 0);
  const agent = members.find((member) => member.pubkey === AGENT);
  assert.ok(agent);
  assert.equal(agent.rank, "executive");
  assert.equal(agent.isPersonalAgent, true);
});

test("a head whose role names a vacancy falls through to its own tier", () => {
  const { unrankedAgents } = orgMembersFromSources(
    [employeeHead()],
    [managedHead({ roleId: "nobody-fills-this", tierRank: null })],
  );
  assert.equal(
    unrankedAgents.length,
    1,
    "no tier and no staffed role: unranked",
  );
});

test("the head's manager tag is carried onto the chart member", () => {
  const { members } = orgMembersFromSources(
    [employeeHead()],
    [managedHead({ tierRank: "worker", manager: EMPLOYEE })],
  );
  assert.equal(members[0]?.manager, EMPLOYEE);
});

test("members and unranked agents both sort by pubkey deterministically", () => {
  const { members, unrankedAgents } = orgMembersFromSources(
    [employeeHead()],
    [
      managedHead({ pubkey: OTHER_AGENT, tierRank: "leader" }),
      managedHead({ tierRank: "worker" }),
      // Same pubkey as the employee, no rank of its own: the employee row
      // already has the slot, so the head adds nothing anywhere.
      managedHead({ pubkey: EMPLOYEE, name: "Usurper", tierRank: null }),
    ],
  );
  assert.deepEqual(
    members.map((member) => member.pubkey),
    [AGENT, EMPLOYEE, OTHER_AGENT].sort(),
  );
  assert.deepEqual(unrankedAgents, []);
});
