import assert from "node:assert/strict";
import { test } from "node:test";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { canonicalCompanyJson } from "../company/contracts.ts";
import {
  readFirstJobTaskReceipt,
  resolveFirstJobTaskHead,
} from "./firstJobTaskReceipt.ts";

const relayKey = generateSecretKey();
const relay = getPublicKey(relayKey);
const ownerKey = generateSecretKey();
const request = "6f1d2b3c-0000-4000-8000-000000000001";
const claim = "6f1d2b3c-0000-4000-8000-000000000002";
const target = `30181:${relay}:first-job`;
const action = finalizeEvent(
  {
    kind: 40013,
    created_at: 1000,
    content: "{}",
    tags: [
      ["p", relay],
      ["a", target],
      ["company-action", "1", "thread.attach", request, claim],
    ],
  },
  ownerKey,
);
function receipt(patch = {}, key = relayKey) {
  return finalizeEvent(
    {
      kind: 40014,
      created_at: 1001,
      content: canonicalCompanyJson({
        schema: "colony.company-receipt/v1",
        headEventId: null,
      }),
      tags: [
        ["p", action.pubkey],
        ["e", action.id, "", "company-action"],
        ["a", target],
        ["company-receipt", "1", request, claim, "rejected"],
      ],
      ...patch,
    },
    key,
  );
}

test("only a relay-signed receipt for the exact request, claim, target and owner confirms refusal", () => {
  assert.equal(
    readFirstJobTaskReceipt(action, receipt(), relay)?.outcome,
    "rejected",
  );
  assert.equal(readFirstJobTaskReceipt(action, null, relay), null);
  assert.equal(
    readFirstJobTaskReceipt(action, receipt({}, ownerKey), relay),
    null,
  );
  const original = receipt();
  assert.equal(
    readFirstJobTaskReceipt(
      action,
      { ...original, sig: "0".repeat(128) },
      relay,
    ),
    null,
  );
  for (const [name, index, replacement] of [
    ["p", 1, "a".repeat(64)],
    ["e", 1, "b".repeat(64)],
    ["a", 1, `${target}-other`],
    ["company-receipt", 2, claim],
    ["company-receipt", 3, request],
  ]) {
    const tags = original.tags.map((tag) => [...tag]);
    tags.find((tag) => tag[0] === name)[index] = replacement;
    assert.equal(
      readFirstJobTaskReceipt(action, receipt({ tags }), relay),
      null,
      `${name}[${index}] must match`,
    );
  }
});

test("an applied task receipt recovers an expired action without republishing it", async () => {
  let publishes = 0;
  const applied = { outcome: "applied", headEventId: "a".repeat(64) };
  assert.equal(
    await resolveFirstJobTaskHead(action.id, {
      readReceipt: async () => applied,
      submit: async () => {
        publishes++;
        throw new Error("timestamp expired");
      },
    }),
    applied.headEventId,
  );
  assert.equal(publishes, 0);
});

test("a receipt arriving after a lost publish response recovers the same task", async () => {
  let reads = 0;
  const applied = { outcome: "applied", headEventId: "b".repeat(64) };
  assert.equal(
    await resolveFirstJobTaskHead(action.id, {
      readReceipt: async () => (++reads === 1 ? null : applied),
      submit: async () => {
        throw new Error("lost response");
      },
    }),
    applied.headEventId,
  );
  await assert.rejects(
    resolveFirstJobTaskHead(action.id, {
      readReceipt: async () => null,
      submit: async () => {
        throw new Error("unknown result");
      },
    }),
    /unknown result/,
  );
});
