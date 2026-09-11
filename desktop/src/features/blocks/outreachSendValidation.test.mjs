import assert from "node:assert/strict";
import test from "node:test";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import { canonicalBlockJson } from "./blockActions.ts";
import {
  outreachReceiptStatus,
  runOutreachActionOnce,
  validateOutreachSendAction,
} from "./outreachSendValidation.ts";

const ownerKey = generateSecretKey();
const agentKey = generateSecretKey();
const strangerKey = generateSecretKey();
const ownerPubkey = getPublicKey(ownerKey);
const agentPubkey = getPublicKey(agentKey);
const strangerPubkey = getPublicKey(strangerKey);

const channelId = "36411e44-0e2d-4cfe-bd6e-567eb169db9f";
const instanceId = "11111111-1111-4111-8111-111111111111";
const idempotencyKey = "22222222-2222-4222-8222-222222222222";
const manifestId = "b".repeat(64);

const cardData = {
  action: "Send this email from your Gmail",
  business_name: "Atlantic Plumbing",
  campaign_id: "c81d4e9a-2f36-4b58-8a71-0d6e3f95c247",
  content: {
    body: "Winter callouts are about to spike in Sea Point.",
    subject: "Winter boiler special for Sea Point homes",
  },
  destination: "info@atlanticplumb.co.za",
  expires_at: 1789142400,
  from: "basheer@horizonlabs.co.za",
  lead_id: "3f2a91c4-6d18-4a7b-9e02-5c81b7d4a610",
  status: "pending",
};

function signInstance({ data = cardData, processor = ownerPubkey } = {}) {
  return finalizeEvent(
    {
      kind: 9,
      created_at: 1,
      content: "Email to Atlantic Plumbing",
      tags: [
        ["h", channelId],
        ["p", processor],
        ["e", manifestId, "", "block"],
        ["block", "1", "outreach-email", manifestId, instanceId],
        ["block-attention", "1", "required"],
        ["block-data", canonicalBlockJson(data)],
      ],
    },
    agentKey,
  );
}

function signAction({
  instanceEvent,
  actionId = "outreach.approve",
  processor = ownerPubkey,
  signer = ownerKey,
} = {}) {
  return finalizeEvent(
    {
      kind: 40010,
      created_at: 2,
      content: canonicalBlockJson({ approval_hash: "a".repeat(64) }),
      tags: [
        ["h", channelId],
        ["p", processor],
        ["e", instanceEvent.id, "", "block-instance"],
        ["e", manifestId, "", "block-manifest"],
        ["block-action", "1", actionId, instanceId, idempotencyKey],
      ],
    },
    signer,
  );
}

test("the owner's own approval of their pending outreach card is carried out", () => {
  const instanceEvent = signInstance();
  const validated = validateOutreachSendAction({
    actionEvent: signAction({ instanceEvent }),
    instanceEvent,
    ownerPubkey,
  });
  assert.deepEqual(validated, {
    kind: "send",
    channelId,
    instanceId,
    instanceEventId: instanceEvent.id,
    idempotencyKey,
    destination: "info@atlanticplumb.co.za",
    subject: "Winter boiler special for Sea Point homes",
    body: "Winter callouts are about to spike in Sea Point.",
  });
});

test("skip is recognised as its own decision and never sends", () => {
  const instanceEvent = signInstance();
  const validated = validateOutreachSendAction({
    actionEvent: signAction({ instanceEvent, actionId: "outreach.skip" }),
    instanceEvent,
    ownerPubkey,
  });
  assert.equal(validated?.kind, "skip");
});

test("an action signed by anyone but this owner is refused", () => {
  const instanceEvent = signInstance();
  assert.equal(
    validateOutreachSendAction({
      actionEvent: signAction({ instanceEvent, signer: strangerKey }),
      instanceEvent,
      ownerPubkey,
    }),
    null,
    "a stranger's signature must never send the owner's mail",
  );
  assert.equal(
    validateOutreachSendAction({
      actionEvent: signAction({ instanceEvent }),
      instanceEvent,
      ownerPubkey: strangerPubkey,
    }),
    null,
    "this desktop only acts for the identity it is signed in as",
  );
});

test("a card processed by someone other than the owner is refused", () => {
  const instanceEvent = signInstance({ processor: agentPubkey });
  assert.equal(
    validateOutreachSendAction({
      actionEvent: signAction({ instanceEvent, processor: agentPubkey }),
      instanceEvent,
      ownerPubkey,
    }),
    null,
    "the owner is not the processor of this card, so this desktop must not run it",
  );
});

test("a tampered action or instance envelope is refused", () => {
  const instanceEvent = signInstance();
  const actionEvent = signAction({ instanceEvent });
  assert.equal(
    validateOutreachSendAction({
      actionEvent: { ...actionEvent, content: '{"approval_hash":"changed"}' },
      instanceEvent,
      ownerPubkey,
    }),
    null,
    "a signature that no longer covers the content is not an approval",
  );
  assert.equal(
    validateOutreachSendAction({
      actionEvent,
      instanceEvent: { ...instanceEvent, content: "Email to someone else" },
      ownerPubkey,
    }),
    null,
    "the card the owner approved must be the card that is read back",
  );
});

test("a card that is not pending, or is not an outreach email, is refused", () => {
  for (const status of ["sent", "skipped", "failed", "superseded"]) {
    const instanceEvent = signInstance({
      data: { ...cardData, status },
    });
    assert.equal(
      validateOutreachSendAction({
        actionEvent: signAction({ instanceEvent }),
        instanceEvent,
        ownerPubkey,
      }),
      null,
      `a ${status} card is history, not a decision`,
    );
  }
  const emptyBody = signInstance({
    data: { ...cardData, content: { ...cardData.content, body: "" } },
  });
  assert.equal(
    validateOutreachSendAction({
      actionEvent: signAction({ instanceEvent: emptyBody }),
      instanceEvent: emptyBody,
      ownerPubkey,
    }),
    null,
    "an empty body is never sent",
  );
});

test("an action id this broker does not own is refused", () => {
  const instanceEvent = signInstance();
  assert.equal(
    validateOutreachSendAction({
      actionEvent: signAction({ instanceEvent, actionId: "agent.create" }),
      instanceEvent,
      ownerPubkey,
    }),
    null,
  );
});

test("one action event id runs one send, however many times it is replayed", async () => {
  let runs = 0;
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const operation = async () => {
    runs += 1;
    await gate;
    return "complete";
  };
  const first = runOutreachActionOnce("action-a", operation);
  const duplicate = runOutreachActionOnce("action-a", operation);
  const other = runOutreachActionOnce("action-b", operation);
  release();
  assert.equal(await first, "complete");
  assert.equal(await duplicate, "complete");
  assert.equal(await other, "complete");
  assert.equal(runs, 2, "the replayed action must join the run already open");
});

test("a result maps to the receipt status it is allowed to publish", () => {
  assert.equal(
    outreachReceiptStatus({
      outcome: "sent",
      status_label: "sent",
      sent_at: 1,
      to: "a@b.c",
      subject: "Hi",
    }),
    "succeeded",
  );
  assert.equal(
    outreachReceiptStatus({ outcome: "skipped", status_label: "skipped" }),
    "denied",
  );
  assert.equal(
    outreachReceiptStatus({ outcome: "failed", failure_reason: "no tab" }),
    "failed",
  );
});
