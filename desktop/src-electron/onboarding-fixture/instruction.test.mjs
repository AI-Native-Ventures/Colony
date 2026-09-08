import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { npubEncode } from "nostr-tools/nip19";
import { verifyFixtureInstruction } from "./instruction.mjs";

const key = new Uint8Array(32).fill(1);
const account = {
  ownerPubkey: getPublicKey(key),
  channelId: "00000000-0000-4000-8000-000000000000",
  rootEventId: "a".repeat(64),
};
const scout = { pubkey: "b".repeat(64) };
const worker = { pubkey: "c".repeat(64), name: "Sarah" };
const brief = "Draft five caption and visual-brief pairs.";
const coordination =
  "Coordinate this job in this thread. Ask @Sarah to do the work, review the result, and bring it back here for my review.";
const tags = [
  ["h", account.channelId],
  ["e", account.rootEventId, "", "reply"],
  ["p", scout.pubkey],
  ["mention", worker.pubkey],
];
const sign = (changes = {}) =>
  finalizeEvent(
    {
      kind: 9,
      created_at: 1780000000,
      content: `${brief}\n\n${coordination}`,
      tags,
      ...changes,
    },
    key,
  );
const verify = (event) =>
  verifyFixtureInstruction(event, account, scout, worker, brief);

test("a friendly signed instruction retains Scout-only notification and exact worker reference", () => {
  const proof = verify(sign());
  assert.equal(proof.signatureVerified, true);
  assert.deepEqual(proof.notifyingPubkeys, [scout.pubkey]);
  assert.equal(proof.referencedWorkerPubkey, worker.pubkey);
  assert.equal(proof.workerName, "Sarah");
});

test("the prior raw worker URI cannot satisfy the friendly instruction proof", () => {
  const prior = sign({
    content: `${brief}\n\n${coordination.replace("@Sarah", `nostr:${npubEncode(worker.pubkey)}`)}`,
  });
  assert.throws(() => verify(prior));
});

test("notifying the worker or replacing the referenced identity cannot pass", () => {
  assert.throws(
    () => verify(sign({ tags: [...tags, ["p", worker.pubkey]] })),
    /Only Scout is notified/,
  );
  assert.throws(
    () =>
      verify(
        sign({
          tags: tags.map((tag) =>
            tag[0] === "mention" ? ["mention", scout.pubkey] : tag,
          ),
        }),
      ),
    /non-notifying reference/,
  );
  assert.throws(() => verify({ ...sign(), sig: "0".repeat(128) }));
});
