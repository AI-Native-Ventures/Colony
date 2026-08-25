import assert from "node:assert/strict";
import { test } from "node:test";

import { buildWorkListRows } from "./workListModel.ts";
import {
  buildTasksById,
  countStalledRows,
  isStalledRow,
  unsatisfiedDependsOnCount,
} from "./workBoardModel.ts";

const NOW = 1_800_000_000;

function task(overrides = {}) {
  return {
    schema: "colony.task/v1",
    id: "horizonlabs:task",
    companyId: "horizonlabs",
    initiativeId: null,
    title: "Do the thing",
    status: "inProgress",
    owningTeamId: "relay1:horizonlabs:sales",
    assigneePersonaIds: [],
    qaPersonaId: "relay1:horizonlabs:sales-lead",
    costCentreId: "cc-internal",
    commercialPurpose: "sales",
    clientOrganizationId: null,
    sourceChannelId: "sales",
    sourceEventId: null,
    implicit: false,
    dependsOn: [],
    subject: { kind: "party", ref: "acme" },
    stage: "build-site",
    threadRoot: null,
    doerKind: "agent",
    wakeAt: null,
    createdAt: NOW - 4_000,
    updatedAt: NOW - 600,
    ...overrides,
  };
}

function rowsOf(tasks, runs = {}) {
  return buildWorkListRows(tasks, new Map(Object.entries(runs)), NOW);
}

test("a stale lease on a live task is stalled; the same lease on a finished task is not", () => {
  const live = task({ id: "t:live", status: "inProgress" });
  const finished = task({ id: "t:done", status: "completed" });
  const rows = rowsOf([live, finished], {
    "t:live": { runStatus: "executing", leaseExpiresAt: NOW - 1_200 },
    "t:done": { runStatus: "executing", leaseExpiresAt: NOW - 1_200 },
  });

  const [liveRow, doneRow] = rows;
  assert.equal(isStalledRow(liveRow), true);
  assert.equal(isStalledRow(doneRow), false);
  assert.equal(countStalledRows(rows), 1);
});

test("a healthy executing task and one with no run record are not stalled", () => {
  const healthy = task({ id: "t:healthy" });
  const untracked = task({ id: "t:untracked" });
  const rows = rowsOf([healthy, untracked], {
    "t:healthy": { runStatus: "executing", leaseExpiresAt: NOW + 600 },
  });

  assert.equal(countStalledRows(rows), 0);
});

test("a failed or abandoned run on a live task counts as stalled too", () => {
  const failed = task({ id: "t:failed" });
  const rows = rowsOf([failed], {
    "t:failed": { runStatus: "failed", leaseExpiresAt: null },
  });

  assert.equal(countStalledRows(rows), 1);
});

test("a completed dependency satisfies it; anything else does not", () => {
  const dep = task({ id: "t:dep", status: "completed" });
  const cancelledDep = task({ id: "t:cancelled-dep", status: "cancelled" });
  const tasksById = buildTasksById([dep, cancelledDep]);

  assert.equal(
    unsatisfiedDependsOnCount({ dependsOn: ["t:dep"] }, tasksById),
    0,
  );
  assert.equal(
    unsatisfiedDependsOnCount({ dependsOn: ["t:cancelled-dep"] }, tasksById),
    1,
  );
});

test("a dependency id absent from the task set counts as unsatisfied, not dropped", () => {
  const tasksById = buildTasksById([]);
  assert.equal(
    unsatisfiedDependsOnCount({ dependsOn: ["t:unknown"] }, tasksById),
    1,
  );
});

test("blocked-by count mixes satisfied and unsatisfied correctly", () => {
  const doneDep = task({ id: "t:done-dep", status: "completed" });
  const tasksById = buildTasksById([doneDep]);
  assert.equal(
    unsatisfiedDependsOnCount(
      { dependsOn: ["t:done-dep", "t:missing", "t:missing-2"] },
      tasksById,
    ),
    2,
  );
});
