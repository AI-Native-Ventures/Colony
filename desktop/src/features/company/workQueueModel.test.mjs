import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bounceTargetTaskId,
  canCompleteFromQueue,
  isAssignedToAny,
  isQueueEligible,
  selectMyQueue,
} from "./workQueueModel.ts";

const ME = "aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44";
const NOW = 1_800_000_000;

function task(overrides = {}) {
  return {
    schema: "colony.task/v1",
    id: "horizonlabs:task",
    companyId: "horizonlabs",
    initiativeId: null,
    title: "Run outreach",
    status: "inProgress",
    owningTeamId: "relay1:horizonlabs:sales",
    assigneePersonaIds: [ME],
    qaPersonaId: "relay1:horizonlabs:sales-lead",
    costCentreId: "cc-internal",
    commercialPurpose: "sales",
    clientOrganizationId: null,
    sourceChannelId: "sales",
    sourceEventId: null,
    implicit: false,
    dependsOn: [],
    subject: { kind: "party", ref: "acme" },
    stage: "run-outreach",
    threadRoot: null,
    doerKind: "human",
    wakeAt: null,
    outcomeReason: null,
    bounceReason: null,
    bounceCount: 0,
    createdAt: NOW - 4_000,
    updatedAt: NOW - 600,
    ...overrides,
  };
}

test("assignment matches case-insensitively and refuses an empty identifier set", () => {
  assert.equal(isAssignedToAny(task(), [ME]), true);
  assert.equal(isAssignedToAny(task(), [ME.toUpperCase()]), true);
  assert.equal(isAssignedToAny(task({ assigneePersonaIds: [] }), [ME]), false);
  assert.equal(isAssignedToAny(task(), []), false);
});

test("only live human tasks assigned to me are queue-eligible", () => {
  assert.equal(isQueueEligible(task({ status: "ready" }), [ME]), true);
  assert.equal(isQueueEligible(task({ status: "inProgress" }), [ME]), true);
  assert.equal(isQueueEligible(task({ status: "inReview" }), [ME]), true);
  assert.equal(isQueueEligible(task({ status: "blocked" }), [ME]), false);
  assert.equal(isQueueEligible(task({ status: "snoozed" }), [ME]), false);
  assert.equal(isQueueEligible(task({ status: "completed" }), [ME]), false);
  assert.equal(isQueueEligible(task({ doerKind: "agent" }), [ME]), false);
  assert.equal(
    isQueueEligible(task({ assigneePersonaIds: ["someone-else"] }), [ME]),
    false,
  );
});

test("the queue sorts oldest first", () => {
  const oldest = task({ id: "t:oldest", createdAt: NOW - 10_000 });
  const middle = task({ id: "t:middle", createdAt: NOW - 5_000 });
  const newest = task({ id: "t:newest", createdAt: NOW - 1_000 });
  const queue = selectMyQueue([newest, oldest, middle], [ME]);
  assert.deepEqual(
    queue.map((entry) => entry.id),
    ["t:oldest", "t:middle", "t:newest"],
  );
});

test("the queue excludes work that is not mine, not human, or not live", () => {
  const mine = task({ id: "t:mine" });
  const someoneElses = task({
    id: "t:someone-else",
    assigneePersonaIds: ["not-me"],
  });
  const agentWork = task({ id: "t:agent", doerKind: "agent" });
  const done = task({ id: "t:done", status: "completed" });
  const queue = selectMyQueue([mine, someoneElses, agentWork, done], [ME]);
  assert.deepEqual(
    queue.map((entry) => entry.id),
    ["t:mine"],
  );
});

test("only in-progress or in-review work can complete from the queue", () => {
  assert.equal(canCompleteFromQueue(task({ status: "ready" })), false);
  assert.equal(canCompleteFromQueue(task({ status: "inProgress" })), true);
  assert.equal(canCompleteFromQueue(task({ status: "inReview" })), true);
  assert.equal(canCompleteFromQueue(task({ status: "blocked" })), false);
});

test("bounce is well-defined only with exactly one dependency", () => {
  assert.equal(bounceTargetTaskId(task({ dependsOn: [] })), null);
  assert.equal(
    bounceTargetTaskId(task({ dependsOn: ["horizonlabs:build-site"] })),
    "horizonlabs:build-site",
  );
  assert.equal(
    bounceTargetTaskId(
      task({ dependsOn: ["horizonlabs:build-site", "horizonlabs:pack"] }),
    ),
    null,
  );
});
