import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isCoordinationTeamId,
  teamsSectionIsVisible,
} from "./teamsSectionVisibility.ts";

const WELCOME = { id: "builtin-team:welcome" };
const MINE = { id: "0f6c1b2e-8a44-4d19-9c3e-5b7a0d21f8ac" };
const COORDINATION = { id: "builtin-team:dd1c457e:company-coordination" };

describe("teamsSectionIsVisible", () => {
  it("hides the section when only the Welcome Team is listed", () => {
    assert.equal(teamsSectionIsVisible([WELCOME], false), false);
  });

  it("hides the section when nothing is listed", () => {
    assert.equal(teamsSectionIsVisible([], false), false);
  });

  it("shows the section for a team the person made", () => {
    assert.equal(teamsSectionIsVisible([WELCOME, MINE], false), true);
  });

  // list_teams keeps this community's coordination team, because mentions,
  // tasks and the deploy dialogs resolve a Task's owning team through it. It
  // must not be the thing that puts the section on screen.
  it("a coordination team does not count as a team of your own", () => {
    assert.equal(teamsSectionIsVisible([WELCOME, COORDINATION], false), false);
  });

  // A blueprint's teams belong to the company, not to this client.
  it("shows the section for a team an approved blueprint seeded", () => {
    assert.equal(
      teamsSectionIsVisible(
        [WELCOME, { id: "company-team:abc123:acme:growth" }],
        false,
      ),
      true,
    );
  });

  it("shows the section when the list failed", () => {
    assert.equal(teamsSectionIsVisible([], true), true);
  });
});

describe("isCoordinationTeamId", () => {
  it("recognises a per-community coordination id", () => {
    assert.equal(isCoordinationTeamId(COORDINATION.id), true);
  });

  it("recognises the legacy device-wide id", () => {
    assert.equal(
      isCoordinationTeamId("builtin-team:company-coordination"),
      true,
    );
  });

  it("leaves the Welcome Team alone", () => {
    assert.equal(isCoordinationTeamId(WELCOME.id), false);
  });

  it("leaves a team of your own alone", () => {
    assert.equal(isCoordinationTeamId(MINE.id), false);
  });

  // A blueprint's coordination team is the company's own and is user owned,
  // so it keeps its card.
  it("leaves a blueprint's coordination team alone", () => {
    assert.equal(
      isCoordinationTeamId("company-team:abc123:acme:company-coordination"),
      false,
    );
  });

  // The slug matches on a segment boundary, not as bare trailing text.
  it("does not match a team merely ending in the slug text", () => {
    assert.equal(
      isCoordinationTeamId("builtin-team:acme-company-coordination"),
      false,
    );
  });
});
