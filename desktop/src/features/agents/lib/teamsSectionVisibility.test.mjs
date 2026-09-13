import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { teamsSectionIsVisible } from "./teamsSectionVisibility.ts";

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

  // Belt and braces: list_teams filters coordination teams out, so one
  // reaching the page at all means that rule broke. It must not be the thing
  // that puts the section back on screen.
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
