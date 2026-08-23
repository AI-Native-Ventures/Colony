import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveReportingLine } from "./reportingLine.ts";
import { trustedManagedAgentHeads } from "./managedAgentHeads.ts";
import { KIND_MANAGED_AGENT } from "@/shared/constants/kinds.ts";

const AGENT =
  "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66";
const MANAGER =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER_AGENT =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const OWNER =
  "1111111111111111111111111111111111111111111111111111111111111111";

const OWNERS = new Set([OWNER]);

function employeeHead(overrides = {}) {
  return {
    pubkey: AGENT,
    role: "ops-runner",
    name: "",
    rank: "worker",
    manager: null,
    ...overrides,
  };
}

function managedHeadEvent({
  pubkey = AGENT,
  author = OWNER,
  createdAt = 1_000,
  name,
  manager,
}) {
  const content = {};
  if (name !== undefined) content.name = name;
  const tags = [["d", pubkey.toLowerCase()]];
  if (manager !== undefined) tags.push(["manager", manager]);
  return {
    id: "e".repeat(64),
    pubkey: author,
    created_at: createdAt,
    kind: KIND_MANAGED_AGENT,
    tags,
    content: JSON.stringify(content),
    sig: "f".repeat(128),
  };
}

test("an employee's manager tag names the reporting line", () => {
  const employees = new Map([
    [AGENT, employeeHead({ manager: MANAGER, name: "Rivet" })],
  ]);
  const line = resolveReportingLine(AGENT, {
    employees,
    trustedHeads: [],
  });
  assert.equal(line.managerPubkey, MANAGER);
});

test("the employee row is authoritative even when it names nobody", () => {
  // The relay reads the employees row FIRST; a head that names a manager must
  // not override a hired employee's own (empty) record.
  const employees = new Map([[AGENT, employeeHead({ manager: null })]]);
  const line = resolveReportingLine(AGENT, {
    employees,
    trustedHeads: [
      {
        pubkey: AGENT,
        name: "Sift",
        roleId: null,
        tierRank: "worker",
        manager: OTHER_AGENT,
      },
    ],
  });
  assert.equal(line.managerPubkey, null);
  assert.equal(line.managerLabel, null);
});

test("a managed agent falls back to its owner-authored head's manager tag", () => {
  const trustedHeads = trustedManagedAgentHeads(
    [managedHeadEvent({ name: "Sift", manager: MANAGER })],
    OWNERS,
  );
  const line = resolveReportingLine(AGENT, {
    employees: new Map(),
    trustedHeads,
  });
  assert.equal(line.managerPubkey, MANAGER);
});

test("a self-authored head never contributes a manager", () => {
  // Kind 30177 is client-writable: only owner-authored heads are trusted, so
  // an agent publishing a head naming its own manager must not draw a line.
  const trustedHeads = trustedManagedAgentHeads(
    [managedHeadEvent({ author: AGENT, manager: MANAGER })],
    OWNERS,
  );
  assert.equal(trustedHeads.length, 0);
  const line = resolveReportingLine(AGENT, {
    employees: new Map(),
    trustedHeads,
  });
  assert.equal(line.managerPubkey, null);
  assert.equal(line.managerLabel, null);
});

test("an agent nobody describes has no reporting line", () => {
  const line = resolveReportingLine(OTHER_AGENT, {
    employees: new Map(),
    trustedHeads: [],
  });
  assert.equal(line.managerPubkey, null);
  assert.equal(line.managerLabel, null);
});

test("pubkeys compare case-insensitively", () => {
  const employees = new Map([
    [AGENT, employeeHead({ manager: MANAGER.toUpperCase() })],
  ]);
  const line = resolveReportingLine(AGENT.toUpperCase(), {
    employees,
    trustedHeads: [],
  });
  assert.equal(line.managerPubkey, MANAGER);
});

test("the manager label prefers the employee-head name, then the head name, then the truncated key", () => {
  const byEmployeeName = resolveReportingLine(AGENT, {
    employees: new Map([
      [AGENT, employeeHead({ manager: MANAGER })],
      [MANAGER, employeeHead({ pubkey: MANAGER, name: "Rivet" })],
    ]),
    trustedHeads: [
      {
        pubkey: MANAGER,
        name: "Rivet The Head Name",
        roleId: null,
        tierRank: "leader",
        manager: null,
      },
    ],
  });
  assert.equal(byEmployeeName.managerLabel, "Rivet");

  const byHeadName = resolveReportingLine(AGENT, {
    employees: new Map([[AGENT, employeeHead({ manager: MANAGER })]]),
    trustedHeads: [
      {
        pubkey: MANAGER,
        name: "Rivet",
        roleId: null,
        tierRank: "leader",
        manager: null,
      },
    ],
  });
  assert.equal(byHeadName.managerLabel, "Rivet");

  const byTruncation = resolveReportingLine(AGENT, {
    employees: new Map([[AGENT, employeeHead({ manager: MANAGER })]]),
    trustedHeads: [],
  });
  assert.equal(byTruncation.managerLabel, "bbbbbbbb…bbbb");
});
