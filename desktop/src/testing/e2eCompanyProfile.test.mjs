import assert from "node:assert/strict";
import { test } from "node:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import {
  canonicalCompanyJson,
  parseCompanyHead,
} from "@/features/company/contracts";
import { parseCompanyReceipt } from "@/features/company/workRepository";
import {
  brokerMockCommunityProfileAction,
  mockCommunityProfileHeadRecord,
  signMockCommunityProfileUpdate,
} from "./e2eCompanyProfile.ts";

const ownerSecret = new Uint8Array(32).fill(7);
const relaySecret = new Uint8Array(32).fill(0x2b);
const owner = getPublicKey(ownerSecret);
const relay = getPublicKey(relaySecret);
const requestId = "12345678-1234-5678-9234-123456789abc";
function fixture() {
  const profile = mockCommunityProfileHeadRecord({
    tradingName: "Fresh business",
    createdAt: 100,
    updatedAt: 100,
  });
  const head = finalizeEvent(
    {
      kind: 30179,
      created_at: 100,
      tags: [["d", "profile"]],
      content: canonicalCompanyJson(profile),
    },
    relaySecret,
  );
  const broker = {
    ownerPubkey: owner,
    relaySecret,
    heads: [head],
    actions: [],
    receipts: [],
  };
  const context = {
    identity: { pubkey: owner, privateKey: bytesToHex(ownerSecret) },
    relayUrl: "wss://fresh.test",
    relayPubkey: relay,
  };
  const input = {
    profile: JSON.stringify({
      ...profile,
      summary: "Branding for service businesses.",
      website: "https://horizon.example",
      updatedAt: 101,
    }),
    expectedHeadEventId: head.id,
    relayPubkey: relay,
    requestId,
    expectedOwnerPubkey: owner,
    expectedRelayUrl: "wss://fresh.test/",
  };
  return { profile, head, broker, context, input };
}

test("fresh mock profile is unconfigured; signed update yields canonical relay head and exact receipt", async () => {
  const f = fixture();
  assert.equal(f.profile.summary, "");
  assert.equal(f.profile.website, null);
  assert.deepEqual(f.profile.services, []);
  const action = JSON.parse(
    await signMockCommunityProfileUpdate(f.input, f.context),
  );
  assert.equal(verifyEvent(action), true);
  assert.equal(action.pubkey, owner);
  assert.equal(brokerMockCommunityProfileAction(action, f.broker), true);
  assert.equal(f.broker.heads.length, 2);
  const saved = parseCompanyHead(f.broker.heads[1], relay);
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.value, JSON.parse(f.input.profile));
  const receipt = parseCompanyReceipt(f.broker.receipts[0], relay, action.id);
  assert.equal(receipt.outcome, "applied");
  assert.equal(receipt.headEventId, f.broker.heads[1].id);
  assert.equal(receipt.requestId, requestId);
  assert.equal(f.broker.actions.length, 1);
  assert.deepEqual(
    f.broker.heads.map((entry) => entry.kind),
    [30179, 30179],
  );
});

test("exact signed retry has one action, one head and one receipt", async () => {
  const f = fixture();
  const action = JSON.parse(
    await signMockCommunityProfileUpdate(f.input, f.context),
  );
  assert.equal(brokerMockCommunityProfileAction(action, f.broker), true);
  assert.equal(
    brokerMockCommunityProfileAction(structuredClone(action), f.broker),
    true,
  );
  assert.equal(f.broker.actions.length, 1);
  assert.equal(f.broker.heads.length, 2);
  assert.equal(f.broker.receipts.length, 1);
});

test("stale expected head receives conflict without overwriting the accepted business", async () => {
  const f = fixture();
  const original = JSON.parse(
    await signMockCommunityProfileUpdate(f.input, f.context),
  );
  assert.equal(brokerMockCommunityProfileAction(original, f.broker), true);
  const stale = JSON.parse(
    await signMockCommunityProfileUpdate(
      {
        ...f.input,
        requestId: "12345678-1234-5678-9234-123456789abd",
        profile: JSON.stringify({
          ...JSON.parse(f.input.profile),
          summary: "Stale replacement",
        }),
      },
      f.context,
    ),
  );
  assert.equal(brokerMockCommunityProfileAction(stale, f.broker), true);
  assert.equal(
    parseCompanyReceipt(f.broker.receipts[1], relay, stale.id).outcome,
    "conflict",
  );
  assert.equal(f.broker.heads.length, 2);
  assert.equal(
    JSON.parse(f.broker.heads[1].content).summary,
    "Branding for service businesses.",
  );
});

test("mock signer enforces owner, relay and profile limits; ordinary settings remain unscoped", async () => {
  const f = fixture();
  for (const input of [
    { ...f.input, expectedOwnerPubkey: "a".repeat(64) },
    { ...f.input, expectedRelayUrl: "wss://other.test" },
    { ...f.input, expectedOwnerPubkey: undefined },
    { ...f.input, relayPubkey: "b".repeat(64) },
    {
      ...f.input,
      profile: JSON.stringify({ ...f.profile, summary: "x".repeat(4001) }),
    },
  ])
    await assert.rejects(signMockCommunityProfileUpdate(input, f.context));
  const {
    expectedOwnerPubkey: _owner,
    expectedRelayUrl: _relay,
    ...settings
  } = f.input;
  assert.equal(
    verifyEvent(
      JSON.parse(await signMockCommunityProfileUpdate(settings, f.context)),
    ),
    true,
  );
});

test("mock broker refuses forged owner, noncanonical payload and wrong relay without profile writes", async () => {
  const f = fixture();
  const action = JSON.parse(
    await signMockCommunityProfileUpdate(f.input, f.context),
  );
  const candidates = [
    { ...action, sig: "0".repeat(128) },
    finalizeEvent(
      {
        ...action,
        content: JSON.stringify(JSON.parse(action.content), null, 2),
      },
      ownerSecret,
    ),
    finalizeEvent(
      {
        ...action,
        tags: action.tags.map((tag) =>
          tag[0] === "p" ? ["p", "a".repeat(64)] : tag,
        ),
      },
      ownerSecret,
    ),
    finalizeEvent(action, new Uint8Array(32).fill(9)),
  ];
  for (const bad of candidates)
    assert.equal(brokerMockCommunityProfileAction(bad, f.broker), false);
  assert.equal(f.broker.heads.length, 1);
  assert.equal(f.broker.actions.length, 0);
  assert.equal(f.broker.receipts.length, 0);
  assert.equal(
    brokerMockCommunityProfileAction(
      { ...action, tags: [["a", `30181:${relay}:task`]] },
      f.broker,
    ),
    null,
  );
});
