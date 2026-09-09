import assert from "node:assert/strict";
import { verifyEvent } from "nostr-tools/pure";

/** Resolve one real logical Task while retaining public revision diagnostics. */
export function readCurrentFixtureTask(events, scope, onCandidates = () => {}) {
  const candidates = events.map((event) => {
    let task = null;
    let signatureVerified = false;
    try {
      task = JSON.parse(event.content);
    } catch {
      /* projected below */
    }
    try {
      signatureVerified = verifyEvent(event);
    } catch {
      /* rejected below */
    }
    return {
      eventId: event.id,
      kind: event.kind,
      author: event.pubkey,
      createdAt: event.created_at,
      dTags: event.tags.filter((tag) => tag[0] === "d"),
      taskId: task?.id ?? null,
      status: task?.status ?? null,
      channelId: task?.sourceChannelId ?? null,
      rootId: task?.threadRoot ?? null,
      signatureVerified,
    };
  });
  onCandidates(candidates);
  const matches = events.filter((event, index) => {
    const candidate = candidates[index];
    assert.equal(event.kind, 30181);
    assert.equal(event.pubkey, scope.relayPubkey);
    assert.equal(candidate.signatureVerified, true);
    const task = JSON.parse(event.content);
    assert.equal(task.schema, "colony.task/v1");
    assert.equal(typeof task.id, "string");
    assert.ok(task.id.length > 0);
    assert.deepEqual(candidate.dTags, [["d", task.id]]);
    return (
      task.threadRoot === scope.rootId &&
      task.sourceChannelId === scope.channelId
    );
  });
  assert.equal(
    new Set(matches.map((event) => JSON.parse(event.content).id)).size,
    1,
    "Exactly one logical Task for the first-job thread",
  );
  // Same ordering as company/contracts.ts newestHead: latest timestamp wins;
  // equal timestamps converge on the lowest event id, not the first response.
  const current = matches.reduce(
    (winner, event) =>
      !winner ||
      event.created_at > winner.created_at ||
      (event.created_at === winner.created_at && event.id < winner.id)
        ? event
        : winner,
    null,
  );
  assert.ok(current);
  return JSON.parse(current.content);
}
