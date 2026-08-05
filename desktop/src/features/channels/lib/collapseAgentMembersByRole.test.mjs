import assert from "node:assert/strict";
import test from "node:test";

import { collapseAgentMembersByRole } from "./collapseAgentMembersByRole.ts";

const roleOf = (agent) => agent.role;
const isOwn = (agent) => agent.own === true;

function agent(name, role, own = false) {
  return { name, role, own };
}

test("two members' instances of one role collapse to a single entry", () => {
  const theirs = agent("Chief of Staff", "chief-of-staff");
  const mine = agent("Chief of Staff", "chief-of-staff", true);

  assert.deepEqual(collapseAgentMembersByRole([theirs, mine], roleOf, isOwn), [
    mine,
  ]);
});

test("the viewer's own instance survives regardless of order", () => {
  const mine = agent("Chief of Staff", "chief-of-staff", true);
  const theirs = agent("Chief of Staff", "chief-of-staff");

  assert.deepEqual(collapseAgentMembersByRole([mine, theirs], roleOf, isOwn), [
    mine,
  ]);
});

test("a role keeps the position of its first occurrence", () => {
  const scout = agent("Scout", "scout");
  const theirChief = agent("Chief of Staff", "chief-of-staff");
  const herald = agent("Herald", "herald");
  const myChief = agent("Chief of Staff", "chief-of-staff", true);

  assert.deepEqual(
    collapseAgentMembersByRole(
      [scout, theirChief, herald, myChief],
      roleOf,
      isOwn,
    ),
    [scout, myChief, herald],
  );
});

test("distinct roles are never merged", () => {
  const chief = agent("Chief of Staff", "chief-of-staff");
  const scout = agent("Scout", "scout");

  assert.deepEqual(collapseAgentMembersByRole([chief, scout], roleOf, isOwn), [
    chief,
    scout,
  ]);
});

test("role matching ignores case and surrounding space", () => {
  const theirs = agent("Chief of Staff", " Chief-Of-Staff ");
  const mine = agent("Chief of Staff", "chief-of-staff", true);

  assert.deepEqual(collapseAgentMembersByRole([theirs, mine], roleOf, isOwn), [
    mine,
  ]);
});

test("role-less agents are never merged with each other", () => {
  // Unknown role means unknown, not "same as the other unknown" — two
  // hand-built agents that happen to share a name stay two entries.
  const first = agent("Helper", null);
  const second = agent("Helper", undefined);

  assert.deepEqual(collapseAgentMembersByRole([first, second], roleOf, isOwn), [
    first,
    second,
  ]);
});

test("a role-less agent never displaces a roled one", () => {
  const roleless = agent("Chief of Staff", null, true);
  const roled = agent("Chief of Staff", "chief-of-staff");

  assert.deepEqual(
    collapseAgentMembersByRole([roleless, roled], roleOf, isOwn),
    [roleless, roled],
  );
});

test("three instances of one role collapse to the owned one", () => {
  const a = agent("Chief of Staff", "chief-of-staff");
  const b = agent("Chief of Staff", "chief-of-staff");
  const mine = agent("Chief of Staff", "chief-of-staff", true);

  assert.deepEqual(collapseAgentMembersByRole([a, b, mine], roleOf, isOwn), [
    mine,
  ]);
});

test("with no owned instance the first stays", () => {
  const a = agent("Chief of Staff", "chief-of-staff");
  const b = agent("Chief of Staff", "chief-of-staff");

  assert.deepEqual(collapseAgentMembersByRole([a, b], roleOf, isOwn), [a]);
});

test("an empty list stays empty", () => {
  assert.deepEqual(collapseAgentMembersByRole([], roleOf, isOwn), []);
});
