import assert from "node:assert/strict";
import { test } from "node:test";

import { teamDisplayName } from "./teamDisplayName.ts";

test("a team the device knows about is named", () => {
  const teams = [
    { id: "team-alpha", name: "Alpha" },
    { id: "builtin-team:9f2a1c3d:company-coordination", name: "Coordination" },
  ];

  assert.equal(teamDisplayName(teams, "team-alpha"), "Alpha");
  assert.equal(
    teamDisplayName(teams, "builtin-team:9f2a1c3d:company-coordination"),
    "Coordination",
  );
});

test("an unknown coordination id falls back to the id itself", () => {
  // A Task minted before this community's coordination team was published,
  // or one minted against another device's copy, resolves to no local team.
  // The dialog shows the id, which names what is missing.
  assert.equal(
    teamDisplayName([], "builtin-team:9f2a1c3d:company-coordination"),
    "builtin-team:9f2a1c3d:company-coordination",
  );
  assert.equal(
    teamDisplayName(undefined, "builtin-team:company-coordination"),
    "builtin-team:company-coordination",
  );
});

test("any other unknown id falls back to the id itself", () => {
  assert.equal(teamDisplayName([], "team-alpha"), "team-alpha");
  assert.equal(
    teamDisplayName([{ id: "team-beta", name: "Beta" }], "team-alpha"),
    "team-alpha",
  );
});
