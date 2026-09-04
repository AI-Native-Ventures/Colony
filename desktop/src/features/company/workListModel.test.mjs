import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildWorkListRows,
  countLiveTasks,
  filterWorkRows,
  formatTaskAge,
  groupWorkRows,
  nestSubTasks,
  reportedCompleteSummary,
  shortIdLabel,
  sortWorkRows,
} from "./workListModel.ts";

const NOW = 1_800_000_000;

function task(overrides = {}) {
  return {
    schema: "colony.task/v1",
    id: "horizonlabs:task",
    initiativeId: null,
    title: "Do the thing",
    status: "inProgress",
    owningTeamId: "relay1:horizonlabs:sales",
    assigneePersonaIds: [],
    qaPersonaId: "relay1:horizonlabs:sales-lead",
    reviewerTeamId: null,
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
    reportedCompleteBy: [],
    hidden: false,
    parentTaskId: null,
    createdAt: NOW - 4_000,
    updatedAt: NOW - 600,
    ...overrides,
  };
}

function rowsOf(tasks, runs = {}) {
  return buildWorkListRows(tasks, new Map(Object.entries(runs)), NOW);
}

test("rows carry both truths: business status and derived execution state", () => {
  const healthy = task({ id: "t:healthy", status: "inProgress" });
  const stalled = task({ id: "t:stalled", status: "inProgress" });
  const rows = rowsOf([healthy, stalled], {
    // Lease expired twenty minutes ago: business says inProgress, the
    // execution record says an agent died.
    "t:stalled": {
      runStatus: "executing",
      leaseExpiresAt: NOW - 1_200,
    },
    "t:healthy": {
      runStatus: "executing",
      leaseExpiresAt: NOW + 1_200,
    },
  });
  const byId = new Map(rows.map((row) => [row.task.id, row]));
  assert.equal(byId.get("t:healthy").execution.key, "executing");
  assert.equal(byId.get("t:stalled").execution.key, "recovery-pending");
  assert.equal(byId.get("t:stalled").execution.tone, "warning");
});

test("a task with no run record is untracked, not failed", () => {
  const [row] = rowsOf([task()]);
  assert.equal(row.execution.key, "untracked");
  assert.equal(row.execution.tone, "neutral");
});

test("implicit tasks are filtered out until the toggle shows them", () => {
  const rows = rowsOf([
    task({ id: "t:asked" }),
    task({ id: "t:chat", implicit: true }),
  ]);
  assert.deepEqual(
    filterWorkRows(rows, { showImplicit: false, initiativeId: null }).map(
      (row) => row.task.id,
    ),
    ["t:asked"],
  );
  assert.equal(
    filterWorkRows(rows, { showImplicit: true, initiativeId: null }).length,
    2,
  );
});

test("the initiative narrow keeps only that initiative's tasks", () => {
  const rows = rowsOf([
    task({ id: "t:a", initiativeId: "i:one" }),
    task({ id: "t:b", initiativeId: "i:two" }),
    task({ id: "t:c", initiativeId: null }),
  ]);
  assert.deepEqual(
    filterWorkRows(rows, { showImplicit: true, initiativeId: "i:one" }).map(
      (row) => row.task.id,
    ),
    ["t:a"],
  );
});

test("attention sort puts trouble first, live next, finished last", () => {
  const rows = rowsOf([
    task({ id: "t:done", status: "completed", updatedAt: NOW - 10 }),
    task({ id: "t:busy", updatedAt: NOW - 20 }),
    task({ id: "t:recoverable", updatedAt: NOW - 30 }),
    task({ id: "t:failed", updatedAt: NOW - 40 }),
  ]).map((row) => {
    if (row.task.id === "t:recoverable") {
      row.execution = { ...row.execution, tone: "warning" };
    }
    if (row.task.id === "t:failed") {
      row.execution = { ...row.execution, tone: "danger" };
    }
    return row;
  });
  assert.deepEqual(
    sortWorkRows(rows, "attention").map((row) => row.task.id),
    ["t:failed", "t:recoverable", "t:busy", "t:done"],
  );
});

test("attention sort falls back to recency inside a band", () => {
  const rows = rowsOf([
    task({ id: "t:older", updatedAt: NOW - 500 }),
    task({ id: "t:newer", updatedAt: NOW - 100 }),
  ]);
  assert.deepEqual(
    sortWorkRows(rows, "attention").map((row) => row.task.id),
    ["t:newer", "t:older"],
  );
});

test("recent and oldest sorts order by update time; title sorts A-Z", () => {
  const rows = rowsOf([
    task({ id: "t:b", title: "Beta", updatedAt: NOW - 100 }),
    task({ id: "t:a", title: "alpha", updatedAt: NOW - 300 }),
  ]);
  assert.deepEqual(
    sortWorkRows(rows, "recent").map((row) => row.task.id),
    ["t:b", "t:a"],
  );
  assert.deepEqual(
    sortWorkRows(rows, "oldest").map((row) => row.task.id),
    ["t:a", "t:b"],
  );
  assert.deepEqual(
    sortWorkRows(rows, "title").map((row) => row.task.title),
    ["alpha", "Beta"],
  );
});

test("grouping by subject uses the swimlane key and names the lead", () => {
  const rows = rowsOf([
    task({ id: "t:1", subject: { kind: "party", ref: "acme" } }),
    task({ id: "t:2", subject: { kind: "party", ref: "acme" } }),
    task({ id: "t:3", subject: { kind: "external", ref: "role-9" } }),
    task({ id: "t:4", subject: null }),
  ]);
  const groups = groupWorkRows(rows, "subject");
  assert.deepEqual(
    groups.map((group) => [group.label, group.rows.length]),
    [
      ["acme", 2],
      ["role-9", 1],
      ["No subject", 1],
    ],
  );
});

test("every group-by is a real field", () => {
  const rows = rowsOf([
    task({
      id: "t:x",
      status: "blocked",
      stage: null,
      owningTeamId: "relay1:h:web-dev",
      initiativeId: "h:launch",
      assigneePersonaIds: ["relay1:h:web-1", "relay1:h:web-2"],
    }),
  ]);
  assert.deepEqual(
    groupWorkRows(rows, "status").map((group) => group.label),
    ["blocked"],
  );
  assert.deepEqual(
    groupWorkRows(rows, "stage").map((group) => group.label),
    ["No stage"],
  );
  assert.deepEqual(
    groupWorkRows(rows, "team").map((group) => group.label),
    ["web-dev"],
  );
  assert.deepEqual(
    groupWorkRows(rows, "initiative").map((group) => group.label),
    ["launch"],
  );
  assert.deepEqual(
    groupWorkRows(rows, "assignee").map((group) => group.label),
    ["web-1, web-2"],
  );
});

test("groups without members of their kind sink to the end", () => {
  const rows = rowsOf([
    task({ id: "t:1", subject: { kind: "party", ref: "zeta" } }),
    task({ id: "t:2", subject: null }),
  ]);
  const groups = groupWorkRows(rows, "subject");
  assert.equal(groups[groups.length - 1].label, "No subject");
});

test("ages render in compact tiers and never go negative", () => {
  assert.equal(formatTaskAge(NOW - 30, NOW), "now");
  assert.equal(formatTaskAge(NOW - 120, NOW), "2m");
  assert.equal(formatTaskAge(NOW - 7_200, NOW), "2h");
  assert.equal(formatTaskAge(NOW - 172_800, NOW), "2d");
  assert.equal(formatTaskAge(NOW + 5_000, NOW), "now");
});

test("shortIdLabel keeps scoped ids readable", () => {
  assert.equal(shortIdLabel("relay1:horizonlabs:sales"), "sales");
  assert.equal(shortIdLabel("acme-lead"), "acme-lead");
  assert.equal(shortIdLabel("a:b:"), "a:b:");
});

test("live counts exclude completed and cancelled tasks", () => {
  const rows = rowsOf([
    task({ id: "t:1" }),
    task({ id: "t:2", status: "completed" }),
    task({ id: "t:3", status: "cancelled" }),
  ]);
  assert.equal(countLiveTasks(rows), 1);
});

// A hidden task only carries the cost of turns that were not work. Showing
// one would put "are you there?" in Work at InProgress beside real
// instructions, which is what made the task list read as a transcript.
test("hidden chat tasks never reach the list", () => {
  const rows = rowsOf([
    task({ id: "t:work" }),
    task({ id: "t:chat", title: "Thread chat", hidden: true, implicit: true }),
  ]);
  const visible = filterWorkRows(rows, {
    showImplicit: true,
    initiativeId: null,
  });
  assert.deepEqual(
    visible.map((row) => row.task.id),
    ["t:work"],
  );
});

// A sub-task read anywhere but beside its parent loses the only thing that
// explains it.
test("sub-tasks are ordered directly under their parent", () => {
  const rows = rowsOf([
    task({ id: "t:parent" }),
    task({ id: "t:other" }),
    task({ id: "t:child", parentTaskId: "t:parent" }),
  ]);
  assert.deepEqual(
    nestSubTasks(rows).map((row) => row.task.id),
    ["t:parent", "t:child", "t:other"],
  );
});

// Filtered out, or fallen off the read ceiling: either way the sub-task is
// still work, so it keeps its own place rather than disappearing.
test("a sub-task whose parent is absent keeps its own place", () => {
  const rows = rowsOf([task({ id: "t:child", parentTaskId: "t:gone" })]);
  assert.deepEqual(
    nestSubTasks(rows).map((row) => row.task.id),
    ["t:child"],
  );
});

test("partial completion is the only state worth a line", () => {
  const assignees = ["persona:a", "persona:b", "persona:c"];
  assert.equal(
    reportedCompleteSummary(
      task({
        assigneePersonaIds: assignees,
        reportedCompleteBy: ["persona:a", "persona:b"],
      }),
    ),
    "2 of 3 agents reported done",
  );
  assert.equal(
    reportedCompleteSummary(
      task({ assigneePersonaIds: assignees, reportedCompleteBy: [] }),
    ),
    null,
  );
  assert.equal(
    reportedCompleteSummary(
      task({ assigneePersonaIds: assignees, reportedCompleteBy: assignees }),
    ),
    null,
  );
});

// A report from somebody the task is not assigned to is not one of its
// shares, so it cannot move the count.
test("only assignees count towards the reported total", () => {
  assert.equal(
    reportedCompleteSummary(
      task({
        assigneePersonaIds: ["persona:a", "persona:b"],
        reportedCompleteBy: ["persona:a", "persona:stranger"],
      }),
    ),
    "1 of 2 agents reported done",
  );
});
