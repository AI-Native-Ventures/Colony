import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  blockCapabilities,
  blockDetailDisclosure,
  blockDismissal,
  blockFallbackLines,
  blockStatusLine,
  projectBlockFeedItem,
} from "./blockActionCenter.ts";
import {
  buildActionCenterItems,
  filterActionCenterItems,
} from "../actionCenterModel.ts";
import { sourceLabel } from "../ui/ActionCenterRow.tsx";
import { BlockDisclosure } from "@/features/blocks/ui/BlockDisclosure.tsx";
import { resolveActionAvailability } from "@/features/blocks/ui/primitives/resolvers.ts";

const MANIFEST_ID = "b".repeat(64);
const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const DECISION_MAKER = "a".repeat(64);
const PROCESSOR = "c".repeat(64);

function blockFeedItem(overrides = {}) {
  return {
    id: "e".repeat(64),
    kind: 9,
    pubkey: PROCESSOR,
    content: "## Approve the launch spend\nApproves 500 for the launch",
    createdAt: 300,
    channelId: "channel-1",
    channelName: "general",
    tags: [
      ["e", MANIFEST_ID, "", "block"],
      ["block", "1", "approval", MANIFEST_ID, INSTANCE_ID],
      ["block-data", '{"amount":500}'],
      ["block-attention", "1", "required"],
      ["p", DECISION_MAKER],
      ["block-processor", "1", PROCESSOR],
    ],
    category: "needs_action",
    ...overrides,
  };
}

function plainMessageItem(overrides = {}) {
  return {
    id: "f".repeat(64),
    kind: 9,
    pubkey: DECISION_MAKER,
    content: "Message body",
    createdAt: 200,
    channelId: "channel-1",
    channelName: "general",
    tags: [["e", "root-1"]],
    category: "needs_action",
    ...overrides,
  };
}

test("a block-attention feed item becomes a block row that waits on this person", () => {
  const feedItem = blockFeedItem();
  const items = buildActionCenterItems({
    asks: [],
    feed: {
      mentions: [],
      needsAction: [feedItem],
      activity: [],
      agentActivity: [],
    },
    reminders: [],
  });

  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.kind, "block");
  assert.equal(item.id, `block:${feedItem.id}`);
  assert.equal(item.state, "needs-action");
  assert.equal(item.source.awaitingDecision, true);
  assert.deepEqual(item.capabilities, [
    "decide-inline",
    "open-source",
    "hide-locally",
  ]);
  assert.equal(item.title, "Approve the launch spend");
  assert.equal(item.summary, "Approves 500 for the launch");
  assert.equal(filterActionCenterItems(items, "blocks").length, 1);
  assert.equal(filterActionCenterItems(items, "needs-action").length, 1);
});

test("a block row never mistakes its manifest reference for a thread root", () => {
  const standalone = buildActionCenterItems({
    asks: [],
    feed: {
      mentions: [],
      needsAction: [blockFeedItem()],
      activity: [],
      agentActivity: [],
    },
    reminders: [],
  });
  assert.equal(standalone[0]?.source.kind, "block");
  assert.equal(
    standalone[0]?.source.kind === "block"
      ? standalone[0].source.threadRootId
      : undefined,
    null,
    "the manifest e tag must not be read as a thread root",
  );

  const reply = buildActionCenterItems({
    asks: [],
    feed: {
      mentions: [],
      needsAction: [
        blockFeedItem({
          tags: [
            ["e", "thread-root-1", "", "root"],
            ["e", MANIFEST_ID, "", "block"],
            ["block", "1", "approval", MANIFEST_ID, INSTANCE_ID],
            ["block-data", '{"amount":500}'],
            ["block-attention", "1", "required"],
            ["p", DECISION_MAKER],
            ["block-processor", "1", PROCESSOR],
          ],
        }),
      ],
      activity: [],
      agentActivity: [],
    },
    reminders: [],
  });
  assert.equal(reply[0]?.source.kind, "block");
  assert.equal(
    reply[0]?.source.kind === "block"
      ? reply[0].source.threadRootId
      : undefined,
    "thread-root-1",
  );
});

test("an ordinary message, and a malformed block, stay ordinary messages", () => {
  const items = buildActionCenterItems({
    asks: [],
    feed: {
      mentions: [],
      needsAction: [
        plainMessageItem(),
        blockFeedItem({
          id: "9".repeat(64),
          tags: [["block", "1"]],
        }),
      ],
      activity: [],
      agentActivity: [],
    },
    reminders: [],
  });

  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item.kind === "message"));
  const malformed = items.find((item) => item.id.endsWith("9".repeat(64)));
  assert.ok(malformed);
  assert.deepEqual(malformed.capabilities, ["open-source", "mark-done"]);
});

test("an instance the relay resolved leaves the needs-action queue", () => {
  // The relay's needs-action feed subtracts resolved receipts, so the resolved
  // instance only reaches the client through another category.
  const items = buildActionCenterItems({
    asks: [],
    feed: {
      mentions: [],
      needsAction: [],
      activity: [blockFeedItem({ category: "activity" })],
      agentActivity: [],
    },
    reminders: [],
  });

  const [item] = items;
  assert.equal(item.kind, "block");
  assert.equal(item.source.awaitingDecision, false);
  assert.equal(item.state, "active");
  assert.deepEqual(item.capabilities, [
    "decide-inline",
    "open-source",
    "mark-done",
  ]);
  assert.equal(filterActionCenterItems(items, "needs-action").length, 0);
});

test("a locally hidden row says it is hidden, never that it is resolved", () => {
  const projection = projectBlockFeedItem(
    blockFeedItem({ content: "Approve the launch spend" }),
    null,
    true,
  );
  assert.ok(projection);
  assert.equal(projection.source.awaitingDecision, false);
  assert.equal(
    projection.summary,
    "Hidden from your list, but this still needs your decision.",
  );
  assert.deepEqual(projection.capabilities, [
    "decide-inline",
    "open-source",
    "undo-done",
  ]);
});

test("an untrusted publisher yields the fallback sentence, a visible warning, and no usable decision buttons", () => {
  const disclosure = blockDetailDisclosure({
    event: {
      id: MANIFEST_ID,
      pubkey: PROCESSOR,
      created_at: 1,
      kind: 40012,
      tags: [],
      content: "",
      sig: "",
    },
    manifest: {
      permissions: [{ capability: "spend", constraints: {} }],
    },
    digest: "",
    trust: "untrusted",
  });
  assert.ok(disclosure);
  assert.equal(disclosure.untrusted, true);
  assert.deepEqual(disclosure.permissionLabels, ["spend"]);

  const html = renderToStaticMarkup(
    React.createElement(BlockDisclosure, {
      permissionLabels: disclosure.permissionLabels,
      untrusted: true,
    }),
  );
  assert.match(html, /Untrusted publisher/);
  assert.match(html, /Requires spend/);
  assert.doesNotMatch(
    html,
    /sr-only/,
    "the untrusted warning must be visible, not screen-reader only",
  );

  // The fallback sentence the detail pane shows while the card is refused.
  assert.deepEqual(blockFallbackLines("## Approve the launch spend"), {
    headline: "Approve the launch spend",
    detail: "",
  });

  // The renderer's own gate: an untrusted environment disables every declared
  // action, so no decision button the relay would refuse is ever pressable.
  const availability = resolveActionAvailability(
    {
      label: "Approve",
      interaction: {
        type: "signed",
        action_id: "approval.approve",
        resolves_attention: true,
      },
    },
    {
      trusted: false,
      origin: "untrusted",
      declaredActionIds: new Set(["approval.approve"]),
      disabledReason:
        "Actions are disabled because this publisher is not trusted.",
    },
  );
  assert.equal(availability.enabled, false);

  // The pane's own footer still only offers honest local dismissal.
  const dismissal = blockDismissal([
    "decide-inline",
    "open-source",
    "hide-locally",
  ]);
  assert.equal(dismissal.kind, "hide-locally");
});

test("the capability matrix offers dismissal that matches what the row is waiting on", () => {
  assert.deepEqual(
    blockCapabilities({
      awaitingDecision: true,
      hasChannel: true,
      isDone: false,
      requiresAttention: true,
    }),
    ["decide-inline", "open-source", "hide-locally"],
    "a row waiting on this person hides locally, it is never marked done",
  );
  assert.deepEqual(
    blockCapabilities({
      awaitingDecision: false,
      hasChannel: true,
      isDone: true,
      requiresAttention: true,
    }),
    ["decide-inline", "open-source", "undo-done"],
  );
  assert.deepEqual(
    blockCapabilities({
      awaitingDecision: false,
      hasChannel: true,
      isDone: false,
      requiresAttention: true,
    }),
    ["decide-inline", "open-source", "mark-done"],
    "a resolved decision can be marked done",
  );
  assert.deepEqual(
    blockCapabilities({
      awaitingDecision: false,
      hasChannel: true,
      isDone: false,
      requiresAttention: false,
    }),
    ["decide-inline", "open-source", "mark-done"],
    "a view that never required attention can be marked done",
  );
  assert.deepEqual(
    blockCapabilities({
      awaitingDecision: true,
      hasChannel: false,
      isDone: false,
      requiresAttention: true,
    }),
    ["decide-inline", "hide-locally"],
  );
});

test("the dismissal plan carries copy that says what hiding really does", () => {
  assert.deepEqual(blockDismissal(["decide-inline", "open-source"]), null);

  const hide = blockDismissal(["decide-inline", "hide-locally"]);
  assert.equal(hide.kind, "hide-locally");
  assert.equal(hide.label, "Hide from my list");
  assert.match(
    hide.explanation,
    /does not answer this view/,
    "the explanation must say the view is not answered",
  );
  assert.match(
    hide.explanation,
    /stays blocked/,
    "the explanation must say the work stays blocked",
  );

  const done = blockDismissal(["decide-inline", "mark-done"]);
  assert.equal(done.kind, "mark-done");
  assert.equal(done.label, "Mark done");
  assert.equal(done.explanation, null);

  const undo = blockDismissal(["decide-inline", "undo-done"]);
  assert.equal(undo.kind, "undo-done");
  assert.equal(undo.label, "Put back in Action Center");
  assert.equal(undo.explanation, null);
});

test("the status line states what the row wants without protocol vocabulary", () => {
  assert.equal(
    blockStatusLine({
      awaitingDecision: true,
      isDone: false,
      instance: { attentionRequired: true },
      item: { category: "needs_action" },
    }),
    "Waiting for your decision.",
  );
  assert.equal(
    blockStatusLine({
      awaitingDecision: false,
      isDone: true,
      instance: { attentionRequired: true },
      item: { category: "needs_action" },
    }),
    "Hidden from your list, but this still needs your decision.",
  );
  assert.equal(
    blockStatusLine({
      awaitingDecision: false,
      isDone: false,
      instance: { attentionRequired: true },
      item: { category: "activity" },
    }),
    null,
  );
  assert.equal(
    blockStatusLine({
      awaitingDecision: false,
      isDone: true,
      instance: { attentionRequired: false },
      item: { category: "needs_action" },
    }),
    null,
  );
});

test("sourceLabel names a block row by what it is waiting on", () => {
  assert.equal(
    sourceLabel({ source: { kind: "block", awaitingDecision: true } }),
    "Block waiting on you",
  );
  assert.equal(
    sourceLabel({ source: { kind: "block", awaitingDecision: false } }),
    "Block",
  );
  assert.equal(
    sourceLabel({
      source: { kind: "message", item: { channelName: "general" } },
    }),
    "#general",
  );
});
