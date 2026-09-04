import assert from "node:assert/strict";
import test from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  isTaskTransitionMessage,
  TaskTransitionRow,
} from "./TaskTransitionRow.tsx";

const RELAY_PUBKEY = "2ab1cd14".padEnd(64, "0");

// The payload the owner saw printed verbatim in the thread panel on 0.16.6.
const TASK_CREATED_CONTENT = JSON.stringify({
  task: "chat:48b2273c-a5e6-537c-b04d-b6a7cc750932",
  team: "builtin-team:dd1c457e:company-coordination",
  title: "not the videos, the iamges @Christine - Graphic Designer",
  type: "task_created",
});

function threadRow(overrides = {}) {
  return {
    id: "a".repeat(64),
    createdAt: 1_700_000_000,
    pubkey: RELAY_PUBKEY,
    author: RELAY_PUBKEY,
    time: "10:32 AM",
    body: TASK_CREATED_CONTENT,
    depth: 1,
    kind: 40099,
    parentId: "b".repeat(64),
    rootId: "b".repeat(64),
    tags: [["e", "b".repeat(64), "", "root"]],
    ...overrides,
  };
}

test("a 40099 task row inside a thread is routed to the system-row path", () => {
  assert.equal(isTaskTransitionMessage(threadRow()), true);
  // An ordinary thread reply keeps the message path.
  assert.equal(
    isTaskTransitionMessage(threadRow({ kind: 9, body: "hello" })),
    false,
  );
  // A kind:40099 the relay authors for something else (membership, DM
  // creation) is not a task row and must not be captioned as one.
  assert.equal(
    isTaskTransitionMessage(
      threadRow({
        body: JSON.stringify({ type: "member_joined", actor: RELAY_PUBKEY }),
      }),
    ),
    false,
  );
});

test("the row renders a caption and never leaks its JSON into a text node", () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskTransitionRow, { message: threadRow() }),
  );

  assert.match(html, /company-coordination/);
  assert.match(html, /created/);
  assert.match(html, /not the videos, the iamges/);

  // The bug: the raw payload reached the screen as the message body, keyed by
  // the relay's own pubkey. Neither may appear anywhere in the markup.
  assert.doesNotMatch(html, /"type"/);
  assert.doesNotMatch(html, /"task"/);
  assert.doesNotMatch(html, /task_created/);
  assert.doesNotMatch(html, new RegExp(RELAY_PUBKEY));
});

test("the caption carries no avatar, reaction, or reply affordance", () => {
  const html = renderToStaticMarkup(
    React.createElement(TaskTransitionRow, { message: threadRow() }),
  );

  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /message-reactions/);
  assert.match(html, /data-testid="task-transition-row"/);
  // One line: an unbounded task title must not wrap the caption open.
  assert.match(html, /truncate/);
});

test("a malformed payload renders nothing rather than a wrong sentence", () => {
  const brokenJson = renderToStaticMarkup(
    React.createElement(TaskTransitionRow, {
      message: threadRow({ body: "{not json" }),
    }),
  );
  assert.equal(brokenJson, "");

  // Known transition type, but no title for the caption to name.
  const untitled = renderToStaticMarkup(
    React.createElement(TaskTransitionRow, {
      message: threadRow({
        body: JSON.stringify({ type: "task_completed", task: "chat:1" }),
      }),
    }),
  );
  assert.equal(untitled, "");
});
