import assert from "node:assert/strict";
import test from "node:test";

import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import {
  parseWebsiteHead,
  parseWebsiteReceipt,
  WebsiteHeadsStore,
} from "./websiteHeads.ts";

const RELAY_SECRET = new Uint8Array(32).fill(7);
const RELAY_PUBKEY = getPublicKey(RELAY_SECRET);
const OTHER_SECRET = new Uint8Array(32).fill(9);
const OWNER = "a".repeat(64);
const COORDINATOR = "b".repeat(64);
const CHANNEL = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
const JOB_ID = "10000000-0000-4000-8000-000000000001";

function draftRecord(overrides = {}) {
  return {
    schema: "colony.website-review/v1",
    jobId: JOB_ID,
    taskId: "website-task",
    channel: CHANNEL,
    threadRoot: "c".repeat(64),
    owner: OWNER,
    coordinator: COORDINATOR,
    sourceUrl: "https://horizon-labs.example",
    status: "draft",
    currentRevision: 0,
    revisions: [],
    approvals: [],
    decisions: [],
    stageEvidence: [],
    ...overrides,
  };
}

function headEvent(record, overrides = {}) {
  return finalizeEvent(
    {
      kind: 30203,
      created_at: 1_800_000_000,
      tags: [
        ["d", JOB_ID],
        ["h", CHANNEL],
        ["task", "website-task"],
        ["thread", "c".repeat(64)],
        ["instance", "d".repeat(64)],
        ["manifest", "e".repeat(64)],
        ["generation", "1"],
        ["p", OWNER],
        ["p", COORDINATOR],
      ],
      content: JSON.stringify(record),
      ...overrides,
    },
    RELAY_SECRET,
  );
}

test("a relay-signed head parses and cross-checks its record", () => {
  const result = parseWebsiteHead(headEvent(draftRecord()), RELAY_PUBKEY);
  assert.equal(result.ok, true);
  assert.equal(result.value.jobId, JOB_ID);
  assert.equal(result.value.generation, 1);
  assert.equal(result.value.instanceEventId, "d".repeat(64));
  assert.equal(result.value.record.status, "draft");
});

test("a head signed by anyone but the relay self key is refused", () => {
  const event = finalizeEvent(
    {
      kind: 30203,
      created_at: 1_800_000_000,
      tags: [
        ["d", JOB_ID],
        ["h", CHANNEL],
        ["task", "website-task"],
        ["thread", "c".repeat(64)],
        ["instance", "d".repeat(64)],
        ["manifest", "e".repeat(64)],
        ["generation", "1"],
        ["p", OWNER],
        ["p", COORDINATOR],
      ],
      content: JSON.stringify(draftRecord()),
    },
    OTHER_SECRET,
  );
  assert.equal(parseWebsiteHead(event, RELAY_PUBKEY).ok, false);
});

test("a head whose record disagrees with its tags is refused", () => {
  const mismatched = draftRecord({ threadRoot: "f".repeat(64) });
  assert.equal(parseWebsiteHead(headEvent(mismatched), RELAY_PUBKEY).ok, false);
});

test("the store keeps the highest generation per thread root", () => {
  const store = new WebsiteHeadsStore();
  const first = headEvent(draftRecord(), { created_at: 1_800_000_000 });
  const second = finalizeEvent(
    {
      kind: 30203,
      created_at: 1_800_000_100,
      tags: [
        ["d", JOB_ID],
        ["h", CHANNEL],
        ["task", "website-task"],
        ["thread", "c".repeat(64)],
        ["instance", "d".repeat(64)],
        ["manifest", "e".repeat(64)],
        ["generation", "2"],
        ["p", OWNER],
        ["p", COORDINATOR],
      ],
      content: JSON.stringify(draftRecord({ status: "working" })),
    },
    RELAY_SECRET,
  );
  assert.equal(
    store.applyEvent("community", CHANNEL, RELAY_PUBKEY, first),
    true,
  );
  assert.equal(
    store.applyEvent("community", CHANNEL, RELAY_PUBKEY, second),
    true,
  );
  // Equal or lower generations are ignored.
  assert.equal(
    store.applyEvent("community", CHANNEL, RELAY_PUBKEY, first),
    false,
  );
  const head = store.headForThread("community", CHANNEL, "c".repeat(64));
  assert.equal(head?.generation, 2);
  assert.equal(head?.record.status, "working");
  assert.equal(
    store.headForInstance("community", CHANNEL, "d".repeat(64))?.eventId,
    second.id,
  );
  assert.equal(store.channelHeads("community", CHANNEL).length, 1);
});

test("channel snapshots are referentially stable", () => {
  const store = new WebsiteHeadsStore();
  // An unknown channel must reuse one shared empty snapshot: a fresh array per
  // getSnapshot call is what made every message row loop after mount.
  assert.equal(
    store.channelHeads("community", CHANNEL),
    store.channelHeads("community", CHANNEL),
  );
  const event = headEvent(draftRecord());
  assert.equal(
    store.applyEvent("community", CHANNEL, RELAY_PUBKEY, event),
    true,
  );
  const loaded = store.channelHeads("community", CHANNEL);
  assert.equal(loaded, store.channelHeads("community", CHANNEL));
  assert.equal(loaded.length, 1);
  assert.notEqual(
    loaded,
    store.channelHeads("community", "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb51"),
  );
});

test("receipts parse for the relay signer and resolve waiters", async () => {
  const actionId = "1".repeat(64);
  const event = finalizeEvent(
    {
      kind: 40028,
      created_at: 1_800_000_000,
      tags: [
        ["h", CHANNEL],
        ["task", "website-task"],
        ["thread", "c".repeat(64)],
        ["p", OWNER],
        ["e", actionId, "", "website-action"],
      ],
      content: JSON.stringify({
        schema: "colony.website-receipt/v1",
        op: "approve",
        outcome: "applied",
        jobId: JOB_ID,
        generation: 2,
        revision: 1,
        headEventId: "3".repeat(64),
      }),
    },
    RELAY_SECRET,
  );
  const store = new WebsiteHeadsStore();
  const waiting = store.waitForReceipt(actionId, 1_000);
  assert.equal(store.applyReceipt(event, RELAY_PUBKEY), true);
  const receipt = await waiting;
  assert.equal(receipt?.op, "approve");
  assert.equal(receipt?.outcome, "applied");
  assert.equal(
    parseWebsiteReceipt(event, getPublicKey(OTHER_SECRET)),
    null,
    "a receipt from another signer is not trusted",
  );
});
