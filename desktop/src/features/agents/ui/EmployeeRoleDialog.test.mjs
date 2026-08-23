import assert from "node:assert/strict";
import { test } from "node:test";

import { managerCandidatesFor } from "../orgMembers.ts";
import { reportsFromRetireRefusal } from "./EmployeeRoleDialog.tsx";

const WORKER =
  "aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66";
const LEADER =
  "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EXECUTIVE =
  "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const OTHER_LEADER =
  "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

function member(pubkey, rank) {
  return { pubkey, name: pubkey.slice(0, 4), role: "", rank, manager: null };
}

const MEMBERS = [
  member(WORKER, "worker"),
  member(LEADER, "leader"),
  member(OTHER_LEADER, "leader"),
  member(EXECUTIVE, "executive"),
];

test("the manager picker offers only agents exactly one rung up", () => {
  assert.deepEqual(
    managerCandidatesFor(MEMBERS, WORKER, "worker").map((m) => m.pubkey),
    [LEADER, OTHER_LEADER],
  );
  assert.deepEqual(
    managerCandidatesFor(MEMBERS, LEADER, "leader").map((m) => m.pubkey),
    [EXECUTIVE],
  );
});

test("the picker never offers the agent itself, even at a self-rung", () => {
  // No rank escalates to itself, so a self-manager is unrepresentable; the
  // exclusion keeps that true independent of input shape.
  const candidates = managerCandidatesFor(
    [member(LEADER, "leader"), member(EXECUTIVE, "executive")],
    LEADER,
    "leader",
  );
  assert.deepEqual(
    candidates.map((m) => m.pubkey),
    [EXECUTIVE],
  );
});

test("an executive or unranked selection offers no manager at all", () => {
  assert.deepEqual(managerCandidatesFor(MEMBERS, LEADER, "executive"), []);
  assert.deepEqual(managerCandidatesFor(MEMBERS, WORKER, null), []);
});

test("a retire refusal yields every report pubkey named in the message", () => {
  const message = `retire refused: ${WORKER}, ${LEADER} still report to ${EXECUTIVE}; reassign them first`;
  assert.deepEqual(reportsFromRetireRefusal(message, EXECUTIVE), [
    WORKER,
    LEADER,
  ]);
});

test("a single-report refusal and an unknown report both parse", () => {
  const message = `retire refused: ${OTHER_LEADER} still report to ${EXECUTIVE}; reassign them first`;
  assert.deepEqual(reportsFromRetireRefusal(message, EXECUTIVE), [
    OTHER_LEADER,
  ]);
});

test("an unrelated refusal names no reports", () => {
  assert.deepEqual(
    reportsFromRetireRefusal("update refused: executives carry no manager"),
    [],
  );
  // The retired target itself is never listed as its own report.
  const message = `retire refused: ${EXECUTIVE} still report to ${EXECUTIVE}; reassign them first`;
  assert.deepEqual(reportsFromRetireRefusal(message, EXECUTIVE), []);
});
