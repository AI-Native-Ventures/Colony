import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { readCurrentFixtureTask } from "./task-head.mjs";

const key = new Uint8Array(32).fill(2);
const scope = {
  relayPubkey: getPublicKey(key),
  channelId: "fixture-channel",
  rootId: "a".repeat(64),
};
const head = (status, createdAt, id = "one-task", extra = {}) =>
  JSON.parse(
    JSON.stringify(
      finalizeEvent(
        {
          kind: 30181,
          created_at: createdAt,
          tags: [["d", id]],
          content: JSON.stringify({
            schema: "colony.task/v1",
            id,
            status,
            threadRoot: scope.rootId,
            sourceChannelId: scope.channelId,
            ...extra,
          }),
        },
        key,
      ),
    ),
  );

test("historical signed revisions remain one logical Task, newest wins", () => {
  const older = head("inProgress", 1);
  const current = head("completed", 2);
  let diagnostics;
  assert.equal(
    readCurrentFixtureTask([older, current], scope, (value) => {
      diagnostics = value;
    }).status,
    "completed",
  );
  assert.equal(diagnostics.length, 2);
  assert.ok(
    diagnostics.every(
      (value) => value.signatureVerified && value.taskId === "one-task",
    ),
  );
});

test("same-second revisions use the production lowest-event-id tie break", () => {
  const revisions = [head("completed", 3), head("inProgress", 3)];
  const winner = [...revisions].sort((a, b) => a.id.localeCompare(b.id))[0];
  assert.equal(
    readCurrentFixtureTask(revisions, scope).status,
    JSON.parse(winner.content).status,
  );
});

test("two logical Task ids cannot be explained away as revisions", () => {
  assert.throws(() =>
    readCurrentFixtureTask(
      [head("completed", 1), head("completed", 2, "another-task")],
      scope,
    ),
  );
});

test("bad signature or d-coordinate is rejected and public candidates survive", () => {
  const tampered = { ...head("completed", 1), sig: "0".repeat(128) };
  let diagnostics;
  assert.throws(() =>
    readCurrentFixtureTask([tampered], scope, (value) => {
      diagnostics = value;
    }),
  );
  assert.equal(diagnostics[0].signatureVerified, false);
  const wrongCoordinate = finalizeEvent(
    { ...head("completed", 1), tags: [["d", "wrong-task"]] },
    key,
  );
  assert.throws(() => readCurrentFixtureTask([wrongCoordinate], scope));
});
