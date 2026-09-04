import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ThreadReplyRow } from "./ThreadReplyRow.tsx";

const RELAY_PUBKEY = "2ab1cd14".padEnd(64, "0");

/**
 * The row the thread panel hands `ThreadReplyRow`, in the shape the relay
 * emits: kind:40099 signed by the relay, anchored to the thread root by an
 * `e` root marker, content the raw task transition payload.
 */
function taskTransitionReply() {
  return {
    id: "a".repeat(64),
    createdAt: 1_700_000_000,
    pubkey: RELAY_PUBKEY,
    author: RELAY_PUBKEY,
    time: "10:32 AM",
    body: JSON.stringify({
      task: "chat:48b2273c-a5e6-537c-b04d-b6a7cc750932",
      team: "builtin-team:dd1c457e:company-coordination",
      title: "not the videos, the iamges @Christine - Graphic Designer",
      type: "task_created",
    }),
    depth: 1,
    kind: 40099,
    parentId: "b".repeat(64),
    rootId: "b".repeat(64),
    tags: [["e", "b".repeat(64), "", "root"]],
  };
}

// Before this split every thread row went straight to `MessageRow`, which
// prints `message.body` as the message text: the payload above reached the
// screen as JSON attributed to the relay's pubkey (desktop 0.16.6). Rendering
// through the caption path is what makes that impossible.
test("a task transition reply renders as a caption, not a message", () => {
  const html = renderToStaticMarkup(
    React.createElement(ThreadReplyRow, {
      message: taskTransitionReply(),
      // Affordances the thread panel passes every reply. The caption path
      // ignores them; asserting on the markup proves it.
      onReply: () => {},
      onToggleReaction: async () => {},
    }),
  );

  assert.match(html, /data-testid="task-transition-row"/);
  assert.doesNotMatch(html, /data-testid="message-row"/);
  assert.doesNotMatch(html, /"type"/);
  assert.doesNotMatch(html, /task_created/);
  assert.doesNotMatch(html, new RegExp(RELAY_PUBKEY));
  assert.match(html, /company-coordination/);
});
