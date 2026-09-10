import assert from "node:assert/strict";
import test from "node:test";

const importPath = `./boardModel.ts?test=${Math.random()}`;

async function load() {
  return import(importPath);
}

function task(overrides = {}) {
  return {
    schema: "colony.task/v1",
    id: "t1",
    initiativeId: null,
    title: "A task",
    status: "ready",
    owningTeamId: "team",
    assigneePersonaIds: [],
    qaPersonaId: "qa",
    reviewerTeamId: null,
    costCentreId: "cc",
    commercialPurpose: "administration",
    clientOrganizationId: null,
    sourceChannelId: "proj-channel",
    sourceEventId: null,
    implicit: false,
    dependsOn: [],
    subject: null,
    stage: null,
    threadRoot: null,
    doerKind: "agent",
    wakeAt: null,
    outcomeReason: null,
    bounceReason: null,
    bounceCount: 0,
    reportedCompleteBy: [],
    hidden: false,
    parentTaskId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function initiative(overrides = {}) {
  return {
    schema: "colony.initiative/v1",
    id: "i1",
    title: "Ship the thing",
    summary: "",
    status: "active",
    ownerPersonaId: "owner",
    costCentreId: "cc",
    commercialPurpose: "administration",
    clientOrganizationId: null,
    expectedCostUsd: null,
    sourceChannelId: "welcome",
    sourceEventId: null,
    templateId: null,
    templateVersion: null,
    cohortId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("every task status maps to exactly one column", async () => {
  const m = await load();
  const seen = new Map();
  for (const status of [
    "proposed",
    "ready",
    "inProgress",
    "inReview",
    "blocked",
    "snoozed",
    "completed",
    "cancelled",
  ]) {
    const column = m.boardColumnForStatus(status);
    assert.ok(m.BOARD_COLUMN_KEYS.includes(column), `${status} → ${column}`);
    seen.set(status, column);
  }
  assert.strictEqual(seen.get("completed"), "done");
  assert.strictEqual(seen.get("cancelled"), "done");
  assert.strictEqual(seen.get("inProgress"), "in-progress");
  assert.strictEqual(seen.get("inReview"), "in-progress");
  assert.strictEqual(seen.get("ready"), "todo");
  assert.strictEqual(seen.get("blocked"), "todo");
  assert.strictEqual(seen.get("snoozed"), "todo");
  assert.strictEqual(seen.get("proposed"), "todo");
});

test("columns keep a deterministic order and carry their statuses", async () => {
  const m = await load();
  const board = m.projectBoard({
    tasks: [],
    initiatives: [],
    channelId: "proj-channel",
  });
  assert.deepStrictEqual(
    board.columns.map((column) => column.key),
    ["todo", "in-progress", "done"],
  );
  assert.deepStrictEqual(
    board.columns.find((column) => column.key === "in-progress").statuses,
    ["inProgress", "inReview"],
  );
  assert.deepStrictEqual(
    board.columns.find((column) => column.key === "done").statuses,
    ["completed", "cancelled"],
  );
});

test("scopes to the project channel by sourceChannelId", async () => {
  const m = await load();
  const board = m.projectBoard({
    tasks: [
      task({ id: "mine", sourceChannelId: "proj-channel" }),
      task({ id: "theirs", sourceChannelId: "other-channel" }),
    ],
    initiatives: [],
    channelId: "proj-channel",
  });
  const ids = board.columns.flatMap((column) =>
    column.tasks.map((entry) => entry.id),
  );
  assert.deepStrictEqual(ids, ["mine"]);
});

test("pulls in tasks whose initiative belongs to this channel", async () => {
  const m = await load();
  const board = m.projectBoard({
    tasks: [
      task({
        id: "kickoff",
        sourceChannelId: "welcome",
        initiativeId: "i1",
      }),
    ],
    initiatives: [initiative({ id: "i1", sourceChannelId: "proj-channel" })],
    channelId: "proj-channel",
  });
  assert.strictEqual(board.progress.total, 1);
  assert.strictEqual(board.initiative?.id, "i1");
});

test("hidden tasks never reach the board", async () => {
  const m = await load();
  const board = m.projectBoard({
    tasks: [task({ id: "cost-only", hidden: true })],
    initiatives: [],
    channelId: "proj-channel",
  });
  assert.strictEqual(board.progress.total, 0);
});

test("progress counts done against the scoped total", async () => {
  const m = await load();
  const board = m.projectBoard({
    tasks: [
      task({ id: "a", status: "completed" }),
      task({ id: "b", status: "cancelled" }),
      task({ id: "c", status: "inProgress" }),
      task({ id: "d", status: "ready" }),
      task({ id: "elsewhere", sourceChannelId: "other" }),
    ],
    initiatives: [],
    channelId: "proj-channel",
  });
  assert.deepStrictEqual(board.progress, { done: 2, total: 4 });
});

test("cards sort newest-updated first inside a column", async () => {
  const m = await load();
  const board = m.projectBoard({
    tasks: [
      task({ id: "old", status: "ready", updatedAt: 10 }),
      task({ id: "new", status: "ready", updatedAt: 99 }),
    ],
    initiatives: [],
    channelId: "proj-channel",
  });
  assert.deepStrictEqual(
    board.columns[0].tasks.map((entry) => entry.id),
    ["new", "old"],
  );
});

test("the header initiative is the one most of the tasks belong to", async () => {
  const m = await load();
  const board = m.projectBoard({
    tasks: [
      task({ id: "a", initiativeId: "i1" }),
      task({ id: "b", initiativeId: "i1" }),
      task({ id: "c", initiativeId: "i2" }),
    ],
    initiatives: [initiative({ id: "i1" }), initiative({ id: "i2" })],
    channelId: "proj-channel",
  });
  assert.strictEqual(board.initiative?.id, "i1");
});

test("no initiative when none of the scoped tasks have one", async () => {
  const m = await load();
  const board = m.projectBoard({
    tasks: [task({ id: "a" })],
    initiatives: [initiative({ id: "i1" })],
    channelId: "proj-channel",
  });
  assert.strictEqual(board.initiative, null);
});

test("boardAssigneeIds dedupes in first-seen order", async () => {
  const m = await load();
  const board = m.projectBoard({
    tasks: [
      task({ id: "a", status: "ready", assigneePersonaIds: ["p:one"] }),
      task({
        id: "b",
        status: "inProgress",
        assigneePersonaIds: ["p:one", "p:two"],
      }),
    ],
    initiatives: [],
    channelId: "proj-channel",
  });
  assert.deepStrictEqual(m.boardAssigneeIds(board), ["p:one", "p:two"]);
});

test("taskPullRequestUrl prefers a run url artifact", async () => {
  const m = await load();
  assert.strictEqual(
    m.taskPullRequestUrl(task(), [
      { kind: "url", reference: "https://example.test/docs", label: null },
      {
        kind: "url",
        reference: "https://github.com/o/r/pull/12",
        label: null,
      },
    ]),
    "https://github.com/o/r/pull/12",
  );
});

test("taskPullRequestUrl falls back to an external subject", async () => {
  const m = await load();
  assert.strictEqual(
    m.taskPullRequestUrl(
      task({
        subject: { kind: "external", ref: "https://github.com/o/r/pull/7" },
      }),
      [],
    ),
    "https://github.com/o/r/pull/7",
  );
  assert.strictEqual(
    m.taskPullRequestUrl(task({ subject: { kind: "party", ref: "acme" } }), []),
    null,
  );
  assert.strictEqual(m.taskPullRequestUrl(task(), []), null);
});

test("pullRequestLabel shortens to the number", async () => {
  const m = await load();
  assert.strictEqual(
    m.pullRequestLabel("https://github.com/o/r/pull/689"),
    "#689",
  );
  assert.strictEqual(m.pullRequestLabel("https://example.test/pull"), "PR");
});

test("assigneeInitials reads the tail of a scoped id", async () => {
  const m = await load();
  assert.strictEqual(m.assigneeInitials("relay1:horizonlabs:sales-lead"), "SL");
  assert.strictEqual(m.assigneeInitials("ada"), "AD");
  assert.strictEqual(m.assigneeInitials(""), "?");
});
