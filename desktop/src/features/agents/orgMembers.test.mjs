import assert from "node:assert/strict";
import { test } from "node:test";

import { archivedHiddenPubkeys, orgMembersFromSources } from "./orgMembers.ts";

const AGENT =
  "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66";
const OTHER_AGENT =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EMPLOYEE =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const ARCHIVED_AGENT =
  "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

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

test("a personal agent with no stated rank still lands on the chart", () => {
  // It used to drop into an Unranked group and off the chart entirely, which
  // put the owner back on the "Set rank" button every time a fresh instance
  // appeared. A head with no role implies Team lead.
  const { members, unrankedAgents } = orgMembersFromSources(
    [employeeHead()],
    [managedHead()],
  );
  assert.equal(members.length, 2);
  assert.equal(
    members.find((member) => member.pubkey === AGENT)?.rank,
    "leader",
  );
  assert.equal(unrankedAgents.length, 0);
});

test("an agent without a display name falls back to a truncated pubkey", () => {
  const { members } = orgMembersFromSources([], [managedHead({ name: null })]);
  assert.equal(members.length, 1);
  assert.match(members[0]?.name ?? "", /aa11bb22/);
  assert.notEqual(members[0]?.name, AGENT);
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

test("a head whose role names a vacancy takes the rank its role implies", () => {
  const { members, unrankedAgents } = orgMembersFromSources(
    [employeeHead()],
    [managedHead({ roleId: "nobody-fills-this", tierRank: null })],
  );
  assert.equal(unrankedAgents.length, 0);
  assert.equal(
    members.find((member) => member.pubkey === AGENT)?.rank,
    "leader",
  );
});

test("a chief of staff with no stated rank is an executive, not a team lead", () => {
  const { members } = orgMembersFromSources(
    [],
    [managedHead({ roleId: "chief-of-staff", tierRank: null })],
  );
  assert.equal(members[0]?.rank, "executive");
});

test("a stated rank always beats the role default", () => {
  const { members } = orgMembersFromSources(
    [],
    [managedHead({ roleId: "chief-of-staff", tierRank: "worker" })],
  );
  assert.equal(members[0]?.rank, "worker");
});

test("the head's manager tag is carried onto the chart member", () => {
  const { members } = orgMembersFromSources(
    [employeeHead()],
    [managedHead({ tierRank: "worker", manager: EMPLOYEE })],
  );
  assert.equal(members[0]?.manager, EMPLOYEE);
});

test("an archived pubkey is excluded from unrankedAgents", () => {
  // The relay's kind:13535 snapshot is the cross-device signal that these
  // leaked foreign identities are gone; the roster must honor it on the
  // unranked side too, not just the chart.
  const { members, unrankedAgents } = orgMembersFromSources(
    [employeeHead()],
    [managedHead()],
    { archived: new Set([AGENT]) },
  );
  assert.equal(unrankedAgents.length, 0);
  assert.equal(members.length, 1);
});

test("an archived agent is excluded from the chart members as well", () => {
  const { members, unrankedAgents } = orgMembersFromSources(
    [],
    [managedHead({ tierRank: "worker" })],
    { archived: new Set([AGENT]) },
  );
  assert.equal(members.length, 0);
  assert.equal(unrankedAgents.length, 0);
});

test("a retired pubkey stays excluded through the same projection", () => {
  const { members } = orgMembersFromSources([employeeHead()], [], {
    retired: new Set([EMPLOYEE]),
  });
  assert.equal(members.length, 0);
});

test("an empty archive snapshot hides nothing from either list", () => {
  const withEmptySets = orgMembersFromSources(
    [employeeHead()],
    [managedHead({ pubkey: OTHER_AGENT, tierRank: "leader" }), managedHead()],
    { archived: new Set(), retired: new Set() },
  );
  const withoutFilter = orgMembersFromSources(
    [employeeHead()],
    [managedHead({ pubkey: OTHER_AGENT, tierRank: "leader" }), managedHead()],
  );
  assert.deepEqual(withEmptySets, withoutFilter);
  assert.equal(withEmptySets.unrankedAgents.length, 0);
});

test("an absent snapshot means hide nothing", () => {
  // undefined covers loading, errored, and disabled alike: React Query has
  // no data for any of them, and all three must leave the roster intact.
  assert.equal(archivedHiddenPubkeys(undefined).size, 0);
});

test("a loaded snapshot becomes a normalized hidden set", () => {
  const hidden = archivedHiddenPubkeys({
    archived: [AGENT, `  ${ARCHIVED_AGENT.toUpperCase()}  `.trim()],
  });
  assert.equal(hidden.size, 2);
  assert.ok(hidden.has(AGENT));
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
