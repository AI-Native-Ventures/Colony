import assert from "node:assert/strict";
import { test } from "node:test";

import { initiativeRows } from "./initiativesModel.ts";

function initiative(overrides) {
  return {
    schema: "colony.initiative/1",
    id: "initiative-1",
    title: "Untitled",
    summary: "",
    status: "proposed",
    ownerPersonaId: "persona-owner",
    costCentreId: "cc-internal",
    commercialPurpose: "internal",
    clientOrganizationId: null,
    expectedCostUsd: null,
    sourceChannelId: "channel-1",
    sourceEventId: null,
    templateId: null,
    templateVersion: null,
    cohortId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function task(overrides) {
  return { id: "task-1", initiativeId: null, ...overrides };
}

test("counts_tasks_per_initiative", () => {
  const rows = initiativeRows(
    [
      initiative({ id: "a", title: "Alpha", status: "active" }),
      initiative({ id: "b", title: "Beta", status: "active" }),
    ],
    [
      task({ id: "t1", initiativeId: "a" }),
      task({ id: "t2", initiativeId: "a" }),
      task({ id: "t3", initiativeId: "b" }),
      task({ id: "t4", initiativeId: "unknown" }),
      task({ id: "t5", initiativeId: null }),
    ],
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.taskCount]),
    [
      ["a", 2],
      ["b", 1],
    ],
  );
});

test("sorts_active_before_proposed_then_by_title", () => {
  const rows = initiativeRows(
    [
      initiative({ id: "p", title: "Aardvark", status: "proposed" }),
      initiative({ id: "z", title: "Zebra", status: "active" }),
      initiative({ id: "m", title: "Marmot", status: "active" }),
      initiative({ id: "c", title: "Alpaca", status: "completed" }),
    ],
    [],
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ["m", "z", "p", "c"],
  );
});

test("an_initiative_with_no_tasks_shows_zero", () => {
  const rows = initiativeRows(
    [initiative({ id: "a", title: "Alpha", status: "active" })],
    [task({ id: "t1", initiativeId: "b" })],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].taskCount, 0);
  assert.equal(rows[0].costCentreId, "cc-internal");
  assert.equal(rows[0].status, "active");
  assert.equal(rows[0].title, "Alpha");
});
