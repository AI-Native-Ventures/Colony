import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAssigneeOptions,
  buildKickoffMessage,
  teamPersonaIds,
} from "./taskAssignees.ts";

const PUBKEY_A = "a".repeat(64);
const PUBKEY_B = "b".repeat(64);

function persona(id, displayName, roleTitle = null) {
  return { id, displayName, roleTitle, roleId: roleTitle ? id : null };
}

function team(id, personaIds, leadPersonaId = null) {
  return { id, personaIds, leadPersonaId };
}

function agent(pubkey, personaId) {
  return { pubkey, personaId };
}

test("a persona on no team cannot be assigned", () => {
  const options = buildAssigneeOptions(
    [persona("p1", "Mia"), persona("p2", "Rex")],
    [team("t1", ["p1"])],
    [],
  );
  assert.deepEqual(
    options.map((option) => option.personaId),
    ["p1"],
  );
});

test("a team lead is assignable even when not listed as a member", () => {
  const options = buildAssigneeOptions(
    [persona("lead", "Ada")],
    [team("t1", [], "lead")],
    [],
  );
  assert.equal(options.length, 1);
  assert.equal(options[0].personaId, "lead");
});

test("options carry the deployed agent's pubkey, or null when none exists", () => {
  const options = buildAssigneeOptions(
    [persona("p1", "Mia"), persona("p2", "Rex")],
    [team("t1", ["p1", "p2"])],
    [agent(PUBKEY_A, "p1")],
  );
  const byId = new Map(options.map((option) => [option.personaId, option]));
  assert.equal(byId.get("p1").pubkey, PUBKEY_A);
  assert.equal(byId.get("p2").pubkey, null);
});

test("options are sorted by label, not by query resolution order", () => {
  const options = buildAssigneeOptions(
    [persona("p1", "Zed"), persona("p2", "Ada")],
    [team("t1", ["p1", "p2"])],
    [],
  );
  assert.deepEqual(
    options.map((option) => option.label),
    ["Ada", "Zed"],
  );
});

test("a role title is shown alongside the name", () => {
  const options = buildAssigneeOptions(
    [persona("p1", "Mia", "CTO")],
    [team("t1", ["p1"])],
    [],
  );
  assert.equal(options[0].label, "Mia · CTO");
});

test("teamPersonaIds collects members and leads across every team", () => {
  const ids = teamPersonaIds([team("t1", ["p1"], "lead1"), team("t2", ["p2"])]);
  assert.deepEqual([...ids].sort(), ["lead1", "p1", "p2"]);
});

test("no kickoff message when the assignee has no deployed agent", () => {
  const message = buildKickoffMessage(
    "Respond with Hello World",
    { personaId: "p1", label: "Mia · CTO", pubkey: null },
    [],
  );
  assert.equal(message, null);
});

test("the kickoff mentions the assignee by name and p-tags the watchers", () => {
  const message = buildKickoffMessage(
    "Respond with Hello World",
    { personaId: "p1", label: "Mia · CTO", pubkey: PUBKEY_A },
    [{ personaId: "p2", label: "Rex", pubkey: PUBKEY_B }],
  );
  assert.deepEqual(message, {
    content: "@Mia Respond with Hello World",
    mentionPubkeys: [PUBKEY_A, PUBKEY_B],
  });
});

test("a watcher without an agent is dropped rather than p-tagged as empty", () => {
  const message = buildKickoffMessage(
    "Ship it",
    { personaId: "p1", label: "Mia", pubkey: PUBKEY_A },
    [{ personaId: "p2", label: "Rex", pubkey: null }],
  );
  assert.deepEqual(message.mentionPubkeys, [PUBKEY_A]);
});
