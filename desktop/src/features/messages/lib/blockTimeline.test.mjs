import assert from "node:assert/strict";
import test from "node:test";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";

import { formatTimelineMessages } from "./formatTimelineMessages.ts";
import {
  CHANNEL_AUX_EVENT_KINDS,
  CHANNEL_TIMELINE_CONTENT_KINDS,
  KIND_BLOCK_ACTION,
  KIND_BLOCK_RECEIPT,
} from "@/shared/constants/kinds";

const CHANNEL = "36411e44-0e2d-4cfe-bd6e-567eb169db9f";
const INSTANCE = "a".repeat(64);
const FOREIGN_INSTANCE = "c".repeat(64);
const MANIFEST = "d".repeat(64);
const INTRUDER = "3".repeat(64);
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const IDEMPOTENCY = "22222222-2222-4222-8222-222222222222";

function event(
  kind,
  id,
  createdAt,
  tags,
  content = "{}",
  pubkey = "1".repeat(64),
) {
  return {
    id,
    pubkey,
    kind,
    created_at: createdAt,
    content,
    tags: [["h", CHANNEL], ...tags],
    sig: "sig",
  };
}

const instance = event(
  9,
  INSTANCE,
  10,
  [
    [
      "block",
      "1",
      "question",
      "d".repeat(64),
      "11111111-1111-4111-8111-111111111111",
    ],
  ],
  "Readable fallback",
);
test("Block actions and only their newest coherent receipt overlay the instance", () => {
  const processorSecret = generateSecretKey();
  const processor = getPublicKey(processorSecret);
  const instanceSecret = generateSecretKey();
  const signedInstance = finalizeEvent(
    {
      kind: 9,
      created_at: 10,
      content: "Readable fallback",
      tags: [
        ["h", CHANNEL],
        ["p", processor],
        ["e", MANIFEST, "", "block"],
        ["block", "1", "question", MANIFEST, INSTANCE_ID],
        ["block-data", '{"title":"Question"}'],
      ],
    },
    instanceSecret,
  );
  const signedAction = finalizeEvent(
    {
      kind: KIND_BLOCK_ACTION,
      created_at: 20,
      content: "{}",
      tags: [
        ["h", CHANNEL],
        ["p", processor],
        ["e", signedInstance.id, "", "block-instance"],
        ["e", MANIFEST, "", "block-manifest"],
        ["block-action", "1", "question.submit", INSTANCE_ID, IDEMPOTENCY],
      ],
    },
    processorSecret,
  );
  const receipt = (created_at, status, overrides = {}) =>
    finalizeEvent(
      {
        kind: KIND_BLOCK_RECEIPT,
        created_at,
        content: "{}",
        tags: [
          ["h", overrides.channel ?? CHANNEL],
          ["e", signedAction.id, "", "block-action"],
          [
            "e",
            overrides.instanceEventId ?? signedInstance.id,
            "",
            "block-instance",
          ],
          ["block-receipt", "1", INSTANCE_ID, IDEMPOTENCY, status],
        ],
      },
      overrides.secret ?? processorSecret,
    );
  const older = receipt(30, "succeeded");
  const newer = receipt(40, "denied");
  const reorderedForeign = receipt(50, "failed", {
    instanceEventId: FOREIGN_INSTANCE,
  });
  const unauthorized = receipt(60, "failed", {
    secret: generateSecretKey(),
  });
  const forged = receipt(70, "failed");
  forged.pubkey = INTRUDER;
  const wrongChannel = receipt(80, "failed", {
    channel: "9e3b66b5-42ca-4a51-8c4f-b487d93ec61e",
  });

  const [message] = formatTimelineMessages(
    [
      wrongChannel,
      forged,
      unauthorized,
      reorderedForeign,
      newer,
      signedInstance,
      older,
      signedAction,
    ],
    null,
    undefined,
    null,
  );
  assert.deepEqual(
    message.blockState?.actions.map(({ id }) => id),
    [signedAction.id],
  );
  assert.deepEqual(
    message.blockState?.receipts.map(({ id }) => id),
    [newer.id],
  );
});

test("foreign and malformed overlays do not mutate ordinary messages", () => {
  const foreignAction = event(KIND_BLOCK_ACTION, "9".repeat(64), 20, [
    ["e", FOREIGN_INSTANCE, "", "block-instance"],
  ]);
  const [message] = formatTimelineMessages(
    [instance, foreignAction],
    null,
    undefined,
    null,
  );
  assert.equal(message.body, "Readable fallback");
  assert.equal(message.blockState, undefined);
});

test("Block actions and receipts are auxiliary rather than timeline rows", () => {
  assert.equal(CHANNEL_AUX_EVENT_KINDS.includes(KIND_BLOCK_ACTION), true);
  assert.equal(CHANNEL_AUX_EVENT_KINDS.includes(KIND_BLOCK_RECEIPT), true);
  assert.equal(
    CHANNEL_TIMELINE_CONTENT_KINDS.includes(KIND_BLOCK_ACTION),
    false,
  );
  assert.equal(
    CHANNEL_TIMELINE_CONTENT_KINDS.includes(KIND_BLOCK_RECEIPT),
    false,
  );
});
