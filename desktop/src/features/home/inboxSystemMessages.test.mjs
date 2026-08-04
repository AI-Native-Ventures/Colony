import assert from "node:assert/strict";
import test from "node:test";

import { isInboxConversationMessage } from "@/features/home/lib/inboxViewHelpers";
import { formatTimelineMessages } from "@/features/messages/lib/formatTimelineMessages";
import {
  KIND_DELETION,
  KIND_STREAM_MESSAGE,
  KIND_SYSTEM_MESSAGE,
} from "@/shared/constants/kinds";

// The inbox thread pane renders every timeline message it is handed, so what
// reaches it has to be conversation content. This covers the filter in
// useHomeInboxContextMessages against the real formatter rather than a stub,
// and the real predicate: a local copy of the filter would keep passing after
// production stopped applying it.

const CHANNEL_ID = "36411e44-0e2d-4cfe-bd6e-567eb169db9f";
const ME = "1".repeat(64);
const PEER = "2".repeat(64);
const RELAY = "3".repeat(64);

function message(id, content, overrides = {}) {
  return {
    id,
    pubkey: PEER,
    kind: KIND_STREAM_MESSAGE,
    created_at: 1_700_000_000,
    content,
    tags: [["h", CHANNEL_ID]],
    sig: "sig",
    ...overrides,
  };
}

function dmCreated(id) {
  return {
    id,
    pubkey: RELAY,
    kind: KIND_SYSTEM_MESSAGE,
    created_at: 1_700_000_001,
    content: JSON.stringify({
      actor: PEER,
      participants: [PEER, ME],
      type: "dm_created",
    }),
    tags: [["h", CHANNEL_ID]],
    sig: "sig",
  };
}

/** The production predicate, not a copy of it. */
function inboxVisible(messages) {
  return messages.filter(isInboxConversationMessage);
}

function format(events) {
  return formatTimelineMessages(events, undefined, ME, null, undefined);
}

test("a dm_created control event never reaches the inbox as a message", () => {
  const formatted = format([
    message("a".repeat(64), "Hi Sift"),
    dmCreated("b".repeat(64)),
  ]);

  // The formatter keeps it, which is right: the channel timeline routes it to
  // SystemMessageRow.
  assert.equal(
    formatted.some((m) => m.kind === KIND_SYSTEM_MESSAGE),
    true,
    "the formatter should still surface system events to callers that render them",
  );

  const visible = inboxVisible(formatted);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].body ?? visible[0].content, "Hi Sift");
  assert.equal(
    visible.some((m) => JSON.stringify(m).includes("dm_created")),
    false,
    "no raw control-event JSON may reach the inbox",
  );
});

test("filtering system rows leaves real deletions applied", () => {
  // Worth pinning because it is the obvious objection to this filter, and the
  // answer is not what it looks like: kind 40099 "message_deleted" is only the
  // visible notice row. The deletion itself rides kind 5 / NIP-29 delete, so
  // dropping 40099 from this pane cannot resurrect anything.
  const target = "c".repeat(64);
  const formatted = format([
    message(target, "deleted by a moderator"),
    {
      id: "d".repeat(64),
      pubkey: PEER,
      kind: KIND_DELETION,
      created_at: 1_700_000_002,
      content: "",
      tags: [["e", target]],
      sig: "sig",
    },
  ]);

  const visible = inboxVisible(formatted);
  const survivor = visible.find((m) => m.id === target);
  assert.equal(
    survivor === undefined || survivor.deleted === true,
    true,
    "a deleted message must stay deleted in the inbox view",
  );
});
