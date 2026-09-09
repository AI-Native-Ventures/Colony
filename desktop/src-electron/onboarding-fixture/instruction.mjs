import assert from "node:assert/strict";
import { verifyEvent } from "nostr-tools/pure";

/** Check the actual signed owner instruction, independently of its UI rendering. */
export function verifyFixtureInstruction(event, account, scout, worker, brief) {
  assert.equal(
    verifyEvent({
      id: event.id,
      kind: event.kind,
      pubkey: event.pubkey,
      created_at: event.created_at,
      content: event.content,
      tags: event.tags.map((tag) => [...tag]),
      sig: event.sig,
    }),
    true,
    "Instruction retains its owner signature",
  );
  assert.equal(event.kind, 9);
  assert.equal(event.pubkey, account.ownerPubkey);
  const tags = (name) => event.tags.filter((tag) => tag[0] === name);
  assert.deepEqual(tags("h"), [["h", account.channelId]]);
  assert.deepEqual(tags("e"), [["e", account.rootEventId, "", "reply"]]);
  assert.deepEqual(tags("p"), [["p", scout.pubkey]], "Only Scout is notified");
  assert.deepEqual(
    tags("mention"),
    [["mention", worker.pubkey]],
    "Worker identity stays a non-notifying reference",
  );
  assert.equal(
    worker.name,
    "Sarah",
    "Use the actual current managed worker name",
  );
  const coordination = `Coordinate this job in this thread. Ask @${worker.name} to do the work, review the result, and bring it back here for my review.`;
  assert.equal(event.content, `${brief}\n\n${coordination}`);
  assert.doesNotMatch(coordination, /nostr:|npub1[a-z0-9]+/);
  return {
    eventId: event.id,
    signatureVerified: true,
    notifyingPubkeys: tags("p").map((tag) => tag[1]),
    referencedWorkerPubkey: worker.pubkey,
    workerName: worker.name,
    coordination,
  };
}

/** Fetch one persisted native message, preserving the real owner/relay path. */
export async function readFixtureInstruction({
  relay,
  invoke,
  account,
  scout,
  worker,
  brief,
}) {
  assert.match(account.channelId, /^[a-f0-9-]{36}$/);
  const eventId = await relay.query(
    `SELECT encode(id,'hex') FROM events WHERE kind=9 AND tags @> '[["h","${account.channelId}"],["client","colony:first-job-start:v1"]]'::jsonb;`,
  );
  assert.match(
    eventId,
    /^[a-f0-9]{64}$/,
    "Exactly one signed first-job instruction",
  );
  const event = JSON.parse(await invoke("get_event", { eventId }));
  assert.equal(event.id, eventId);
  return verifyFixtureInstruction(event, account, scout, worker, brief);
}
