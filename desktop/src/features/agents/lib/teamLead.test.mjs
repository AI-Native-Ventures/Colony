import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveSubmittedTeamLead,
  validateTeamMembership,
} from "./teamPersonas.ts";

test("a team lead must also be a member", () => {
  assert.throws(
    () =>
      validateTeamMembership({
        personaIds: ["persona:builder"],
        leadPersonaId: "persona:lead",
      }),
    /Team lead must also be a member of the team/,
  );
});

test("a persona may only occur once inside one team", () => {
  assert.throws(
    () =>
      validateTeamMembership({
        personaIds: ["persona:lead", "persona:lead"],
        leadPersonaId: "persona:lead",
      }),
    /agent persona:lead can only appear once in a team/,
  );
});

test("the same persona may independently belong to several teams", () => {
  assert.doesNotThrow(() =>
    validateTeamMembership({
      personaIds: ["persona:shared"],
      leadPersonaId: "persona:shared",
    }),
  );
  assert.doesNotThrow(() =>
    validateTeamMembership({
      personaIds: ["persona:shared", "persona:other"],
      leadPersonaId: "persona:other",
    }),
  );
});

test("a team without a lead remains valid", () => {
  assert.doesNotThrow(() =>
    validateTeamMembership({ personaIds: ["persona:member"] }),
  );
});

test("a membership edit carries an unchanged lead through untouched", () => {
  assert.equal(
    resolveSubmittedTeamLead("persona:lead", [
      "persona:lead",
      "persona:builder",
    ]),
    "persona:lead",
  );
});

test("removing the lead from the member list vacates the lead role", () => {
  // The dialog has no lead picker, so resubmitting the stale lead would fail
  // the native member/lead invariant with no way for the user to recover.
  assert.equal(
    resolveSubmittedTeamLead("persona:lead", ["persona:builder"]),
    null,
  );
});

test("a team that never had a lead submits none", () => {
  assert.equal(resolveSubmittedTeamLead(null, ["persona:builder"]), null);
  assert.equal(resolveSubmittedTeamLead(undefined, ["persona:builder"]), null);
});
