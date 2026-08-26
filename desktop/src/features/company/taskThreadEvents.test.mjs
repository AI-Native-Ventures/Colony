import assert from "node:assert/strict";
import { test } from "node:test";

import { describeTaskTransition } from "./taskThreadEvents.tsx";

const REVIEWER = "b".repeat(64);

function payload(overrides = {}) {
  return {
    type: "task_created",
    task: "horizonlabs:launch:build-site",
    title: "Build site · Ridgeway Dental",
    team: "relay1:horizonlabs:web-dev",
    ...overrides,
  };
}

test("created rows name the task and its origin", () => {
  const described = describeTaskTransition(payload());
  assert.ok(described);
  assert.equal(described.author, "web-dev");
  const rendered = JSON.stringify(described.action);
  assert.match(rendered, /created /);
  assert.match(rendered, /Build site · Ridgeway Dental/);
  assert.match(rendered, /from this message/);
});

test("review handoff names the reviewer through the resolver", () => {
  const described = describeTaskTransition(
    payload({
      type: "task_review_handoff",
      reviewer: REVIEWER,
    }),
    (pubkey) => `@${pubkey.slice(0, 4)}`,
  );
  assert.ok(described);
  assert.match(JSON.stringify(described.action), /@bbbb/);
  assert.match(JSON.stringify(described.action), /is in review/);
});

test("an invalid reviewer pubkey is ignored rather than rendered", () => {
  const described = describeTaskTransition(
    payload({ type: "task_review_handoff", reviewer: "not-a-key" }),
  );
  assert.ok(described);
  assert.doesNotMatch(JSON.stringify(described.action), /not-a-key/);
});

test("rejection counts issues and keeps the same-owner ruling", () => {
  const described = describeTaskTransition(
    payload({ type: "task_review_rejected", issues: 2 }),
  );
  assert.ok(described);
  assert.match(JSON.stringify(described.action), /2 issues to fix/);
  assert.match(JSON.stringify(described.action), /same task, same owner/);

  const uncounted = describeTaskTransition(
    payload({ type: "task_review_rejected", issues: 0 }),
  );
  assert.match(JSON.stringify(uncounted?.action), /issues left/);
});

test("bounce and escalation carry a bounded reason when given", () => {
  const bounced = describeTaskTransition(
    payload({ type: "task_bounced", reason: "wrong industry angle" }),
  );
  assert.match(JSON.stringify(bounced?.action), /wrong industry angle/);

  const escalated = describeTaskTransition(
    payload({ type: "task_escalated", reason: "needs owner decision" }),
  );
  assert.match(JSON.stringify(escalated?.action), /needs owner decision/);
});

test("completed and cancelled stay one line", () => {
  for (const type of ["task_completed", "task_cancelled"]) {
    const described = describeTaskTransition(payload({ type }));
    assert.ok(described);
    assert.match(JSON.stringify(described.action), new RegExp(type.slice(5)));
  }
});

test("unknown or malformed payloads render nothing at all", () => {
  assert.equal(describeTaskTransition(null), null);
  assert.equal(describeTaskTransition("task_created"), null);
  assert.equal(
    describeTaskTransition(payload({ type: "task_status_changed" })),
    null,
  );
  assert.equal(describeTaskTransition(payload({ title: "" })), null);
  assert.equal(describeTaskTransition(payload({ task: undefined })), null);
  // A status change that is not one of the seven gets no row either.
  assert.equal(describeTaskTransition(payload({ type: "task_ready" })), null);
});

test("the author slot falls back when no team is on the payload", () => {
  const described = describeTaskTransition(payload({ team: undefined }));
  assert.ok(described);
  assert.equal(described.author, "Work");
});
