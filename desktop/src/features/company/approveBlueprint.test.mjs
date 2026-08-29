import assert from "node:assert/strict";
import { test } from "node:test";

import { createBlueprintApprover } from "./approveBlueprint.ts";

const EVENT_ID = "a".repeat(64);

const INPUT = {
  blueprint: '{"schema":"colony.company-blueprint/v1"}',
  requestId: "3f6c1a2e-0000-4000-8000-000000000001",
  communityScope: "relay.example",
  expectedHash: "b".repeat(64),
  relayPubkey: "c".repeat(64),
  channelId: "3f6c1a2e-1111-4000-8000-000000000009",
  // What the relay minted at boot; approval edits this head rather than
  // creating a fresh one.
  expectedHeadEventId: "d".repeat(64),
  expectedHeadCreatedAt: 1_800_000_000,
  expectedHeadUpdatedAt: 1_800_000_100,
};

function execution(overrides = {}) {
  return {
    outcome: "created",
    personaIds: ["builtin:fizz", "company:abc:horizon-labs:cto"],
    teamIds: ["company-team:abc:horizon-labs:engineering"],
    initiativeIds: ["horizon-labs:init-1"],
    signedActions: ["company", "init-1", "init-2", "init-3"],
    checkpoint: "teams_seeded",
    ...overrides,
  };
}

function harness(overrides = {}) {
  const calls = { published: [], completed: [] };
  const approve = createBlueprintApprover({
    execute: async () => execution(overrides.execution),
    publish:
      overrides.publish ??
      (async (signed) => {
        calls.published.push(signed);
        return EVENT_ID;
      }),
    complete: async (input) => {
      calls.completed.push(input);
      return "horizon-labs";
    },
  });
  return { approve, calls };
}

test("publishes every action and completes with the company event id", async () => {
  const { approve, calls } = harness();
  const outcome = await approve(INPUT);

  assert.equal(outcome.status, "created");
  assert.deepEqual(calls.published, ["company", "init-1", "init-2", "init-3"]);
  assert.equal(calls.completed.length, 1);
  assert.equal(calls.completed[0].companyEventId, EVENT_ID);
});

test("completes with the company head's id, not an initiative's", async () => {
  const ids = [EVENT_ID, "d".repeat(64), "e".repeat(64), "f".repeat(64)];
  let index = 0;
  const { approve, calls } = harness({
    publish: async () => ids[index++],
  });

  await approve(INPUT);
  assert.equal(
    calls.completed[0].companyEventId,
    EVENT_ID,
    "the company head is published first and is what completion records",
  );
});

// The employees already exist by the time publishing runs. Reporting a plain
// failure would invite the owner to start over and approve a second time.
test("a failed publish reports pending, not failure, and does not complete", async () => {
  const { approve, calls } = harness({
    publish: async () => {
      throw new Error("relay unreachable");
    },
  });

  const outcome = await approve(INPUT);
  assert.equal(outcome.status, "pending-publish");
  assert.equal(outcome.publishError, "relay unreachable");
  assert.deepEqual(outcome.personaIds, [
    "builtin:fizz",
    "company:abc:horizon-labs:cto",
  ]);
  assert.equal(
    calls.completed.length,
    0,
    "nothing may be marked complete when the relay never confirmed",
  );
});

// A partial publish is the dangerous case: the company landed but an
// initiative did not. Completing here would let a resumed run skip the write
// that never happened.
test("a publish that fails partway does not complete", async () => {
  let attempts = 0;
  const { approve, calls } = harness({
    publish: async () => {
      attempts += 1;
      if (attempts > 2) {
        throw new Error("connection dropped");
      }
      return EVENT_ID;
    },
  });

  const outcome = await approve(INPUT);
  assert.equal(outcome.status, "pending-publish");
  assert.equal(calls.completed.length, 0);
});

test("an unusable event id from the relay is refused", async () => {
  const { approve, calls } = harness({
    publish: async () => "not-an-event-id",
  });

  const outcome = await approve(INPUT);
  assert.equal(outcome.status, "pending-publish");
  assert.equal(calls.completed.length, 0);
});

// Re-approving is expected: the owner may click twice, or retry after the
// relay was down. It must not read as a second company being created.
test("a recovered execution is reported as recovered", async () => {
  const { approve } = harness({
    execution: { outcome: "recovered", checkpoint: "completed" },
  });

  const outcome = await approve(INPUT);
  assert.equal(outcome.status, "recovered");
});

test("no action is published that the backend did not sign", async () => {
  const { approve, calls } = harness({
    execution: { signedActions: [] },
  });

  const outcome = await approve(INPUT);
  assert.deepEqual(calls.published, []);
  assert.equal(
    outcome.status,
    "pending-publish",
    "an empty action list means the company was never announced",
  );
  assert.equal(calls.completed.length, 0);
});
