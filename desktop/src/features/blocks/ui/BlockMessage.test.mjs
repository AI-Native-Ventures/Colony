import assert from "node:assert/strict";
import test from "node:test";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import { deriveBlockActionViewState } from "./BlockMessage.tsx";
import { resolveAttentionResolution } from "./BlockRenderer.tsx";

const CHANNEL = "36411e44-0e2d-4cfe-bd6e-567eb169db9f";
const MANIFEST = "b".repeat(64);
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const IDEMPOTENCY = "22222222-2222-4222-8222-222222222222";

function signedEvent(secretKey, kind, created_at, tags, content = "{}") {
  return finalizeEvent({ kind, created_at, tags, content }, secretKey);
}

function signedFixture() {
  const processorSecret = generateSecretKey();
  const processorPubkey = getPublicKey(processorSecret);
  const instance = signedEvent(processorSecret, 9, 1, [
    ["h", CHANNEL],
    ["p", processorPubkey],
    ["e", MANIFEST, "", "block"],
    ["block", "1", "question", MANIFEST, INSTANCE_ID],
    ["block-data", '{"title":"Question"}'],
  ]);
  const action = signedEvent(processorSecret, 40010, 2, [
    ["h", CHANNEL],
    ["p", processorPubkey],
    ["e", instance.id, "", "block-instance"],
    ["e", MANIFEST, "", "block-manifest"],
    ["block-action", "1", "question.submit", INSTANCE_ID, IDEMPOTENCY],
  ]);
  return { action, instance, processorPubkey, processorSecret };
}

test("block receipts overlay only their exact signed originating action", () => {
  const fixture = signedFixture();
  const receipt = signedEvent(fixture.processorSecret, 40011, 3, [
    ["h", CHANNEL],
    ["e", fixture.action.id, "", "block-action"],
    ["e", fixture.instance.id, "", "block-instance"],
    ["block-attention", "1", "resolved"],
    ["block-receipt", "1", INSTANCE_ID, IDEMPOTENCY, "succeeded"],
  ]);
  const foreign = signedEvent(fixture.processorSecret, 40011, 4, [
    ["h", CHANNEL],
    ["e", "8".repeat(64), "", "block-action"],
    ["e", fixture.instance.id, "", "block-instance"],
    ["block-receipt", "1", INSTANCE_ID, IDEMPOTENCY, "failed"],
  ]);
  const unauthorized = signedEvent(generateSecretKey(), 40011, 5, [
    ["h", CHANNEL],
    ["e", fixture.action.id, "", "block-action"],
    ["e", fixture.instance.id, "", "block-instance"],
    ["block-receipt", "1", INSTANCE_ID, IDEMPOTENCY, "denied"],
  ]);

  const state = deriveBlockActionViewState(
    {
      id: fixture.instance.id,
      blockEvent: fixture.instance,
      blockState: {
        actions: [fixture.action],
        receipts: [foreign, receipt, unauthorized],
      },
    },
    INSTANCE_ID,
    MANIFEST,
  );
  assert.deepEqual([...state.completedActionIds], ["question.submit"]);
  assert.equal(state.latestStatus, "succeeded");
  assert.equal(state.latestAttentionStatus, "succeeded");
  assert.equal(state.pendingActionId, undefined);
});

test("non-resolving succeeded receipts cannot clear durable attention", () => {
  const fixture = signedFixture();
  const receipt = signedEvent(fixture.processorSecret, 40011, 3, [
    ["h", CHANNEL],
    ["e", fixture.action.id, "", "block-action"],
    ["e", fixture.instance.id, "", "block-instance"],
    ["block-receipt", "1", INSTANCE_ID, IDEMPOTENCY, "succeeded"],
  ]);
  const state = deriveBlockActionViewState(
    {
      id: fixture.instance.id,
      blockEvent: fixture.instance,
      blockState: { actions: [fixture.action], receipts: [receipt] },
    },
    INSTANCE_ID,
    MANIFEST,
  );

  assert.equal(state.latestStatus, "succeeded");
  assert.equal(state.latestAttentionStatus, undefined);
  assert.equal(
    resolveAttentionResolution(true, state.latestAttentionStatus),
    undefined,
  );
});

test("failed receipts remain retryable while unreceipted actions are pending", () => {
  const fixture = signedFixture();
  const failed = signedEvent(fixture.processorSecret, 40011, 3, [
    ["h", CHANNEL],
    ["e", fixture.action.id, "", "block-action"],
    ["e", fixture.instance.id, "", "block-instance"],
    ["block-receipt", "1", INSTANCE_ID, IDEMPOTENCY, "failed"],
  ]);
  const failedState = deriveBlockActionViewState(
    {
      id: fixture.instance.id,
      blockEvent: fixture.instance,
      blockState: { actions: [fixture.action], receipts: [failed] },
    },
    INSTANCE_ID,
    MANIFEST,
  );
  assert.equal(failedState.latestStatus, "failed");
  assert.equal(failedState.completedActionIds.size, 0);

  const pendingState = deriveBlockActionViewState(
    {
      id: fixture.instance.id,
      blockEvent: fixture.instance,
      blockState: { actions: [fixture.action], receipts: [] },
    },
    INSTANCE_ID,
    MANIFEST,
  );
  assert.equal(pendingState.latestStatus, "pending");
  assert.equal(pendingState.pendingActionId, "question.submit");
});

test("a newer retry action supersedes an older failed receipt with pending", () => {
  const fixture = signedFixture();
  const failed = signedEvent(fixture.processorSecret, 40011, 3, [
    ["h", CHANNEL],
    ["e", fixture.action.id, "", "block-action"],
    ["e", fixture.instance.id, "", "block-instance"],
    ["block-receipt", "1", INSTANCE_ID, IDEMPOTENCY, "timed-out"],
  ]);
  const retry = signedEvent(fixture.processorSecret, 40010, 4, [
    ["h", CHANNEL],
    ["p", fixture.processorPubkey],
    ["e", fixture.instance.id, "", "block-instance"],
    ["e", MANIFEST, "", "block-manifest"],
    [
      "block-action",
      "1",
      "question.submit",
      INSTANCE_ID,
      "33333333-3333-4333-8333-333333333333",
    ],
  ]);

  const state = deriveBlockActionViewState(
    {
      id: fixture.instance.id,
      blockEvent: fixture.instance,
      blockState: {
        actions: [fixture.action, retry],
        receipts: [failed],
      },
    },
    INSTANCE_ID,
    MANIFEST,
  );

  assert.equal(state.latestStatus, "pending");
  assert.equal(state.pendingActionId, "question.submit");
});

function retryFixture() {
  const fixture = signedFixture();
  const retry = signedEvent(
    fixture.processorSecret,
    40010,
    4,
    fixture.action.tags.map((tag) =>
      tag[0] === "block-action"
        ? [...tag.slice(0, 4), "33333333-3333-4333-8333-333333333333"]
        : tag,
    ),
  );
  const receipt = (action, status, createdAt, resolvesAttention = false) =>
    signedEvent(fixture.processorSecret, 40011, createdAt, [
      ["h", CHANNEL],
      ["e", action.id, "", "block-action"],
      ["e", fixture.instance.id, "", "block-instance"],
      [
        "block-receipt",
        "1",
        INSTANCE_ID,
        action.tags.find((tag) => tag[0] === "block-action")[4],
        status,
      ],
      ...(resolvesAttention ? [["block-attention", "1", "resolved"]] : []),
    ]);
  const state = (receipts) =>
    deriveBlockActionViewState(
      {
        id: fixture.instance.id,
        blockEvent: fixture.instance,
        blockState: { actions: [retry, fixture.action], receipts },
      },
      INSTANCE_ID,
      MANIFEST,
    );
  return { ...fixture, retry, receipt, state };
}

test("a late failure for the previous attempt cannot overwrite a completed retry", () => {
  const fixture = retryFixture();
  const completed = fixture.receipt(fixture.retry, "succeeded", 5, true);
  const stale = fixture.receipt(fixture.action, "failed", 6);
  const state = fixture.state([completed, stale]);

  assert.equal(state.latestStatus, "succeeded");
  assert.equal(state.latestAttentionStatus, "succeeded");
  assert.equal(state.pendingActionId, undefined);
});

test("a late receipt for the previous attempt cannot hide a pending retry", () => {
  const fixture = retryFixture();
  const state = fixture.state([
    fixture.receipt(fixture.action, "timed-out", 6),
  ]);

  assert.equal(state.latestStatus, "pending");
  assert.equal(state.pendingActionId, "question.submit");
});

test("receipts in the same second show the newest action regardless of arrival order", () => {
  const fixture = retryFixture();
  const completed = fixture.receipt(fixture.retry, "succeeded", 5, true);
  const stale = fixture.receipt(fixture.action, "failed", 5);
  for (const receipts of [
    [completed, stale],
    [stale, completed],
  ]) {
    const state = fixture.state(receipts);
    assert.equal(state.latestStatus, "succeeded");
    assert.equal(state.latestAttentionStatus, "succeeded");
  }
});

test("receipt updates for the newest action still use their event ordering", () => {
  const fixture = retryFixture();
  const state = fixture.state([
    fixture.receipt(fixture.retry, "succeeded", 7, true),
    fixture.receipt(fixture.retry, "failed", 5),
    fixture.receipt(fixture.action, "failed", 6),
  ]);

  assert.equal(state.latestStatus, "succeeded");
  assert.equal(state.latestAttentionStatus, "succeeded");
});

test("a resolving receipt may name the state it produced, within narrow limits", () => {
  const fixture = signedFixture();
  const labelled = (content) =>
    deriveBlockActionViewState(
      {
        id: fixture.instance.id,
        blockEvent: fixture.instance,
        blockState: {
          actions: [fixture.action],
          receipts: [
            signedEvent(
              fixture.processorSecret,
              40011,
              3,
              [
                ["h", CHANNEL],
                ["e", fixture.action.id, "", "block-action"],
                ["e", fixture.instance.id, "", "block-instance"],
                ["block-attention", "1", "resolved"],
                ["block-receipt", "1", INSTANCE_ID, IDEMPOTENCY, "succeeded"],
              ],
              content,
            ),
          ],
        },
      },
      INSTANCE_ID,
      MANIFEST,
    ).latestAttentionStatusLabel;
  assert.equal(labelled('{"status_label":"sent"}'), "sent");
  assert.equal(
    labelled('{"summary":"Action succeeded."}'),
    undefined,
    "a receipt without a label leaves the generic wording alone",
  );
  assert.equal(
    labelled('{"status_label":"<img src=x onerror=alert(1)>"}'),
    undefined,
    "the pill renders a short plain word, never arbitrary processor text",
  );
  assert.equal(
    labelled("not json"),
    undefined,
    "an unreadable receipt body is not a label",
  );
});
