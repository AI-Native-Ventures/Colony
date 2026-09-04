import assert from "node:assert/strict";
import test from "node:test";

import {
  KIND_STREAM_MESSAGE_V2,
  KIND_SYSTEM_MESSAGE,
} from "@/shared/constants/kinds";

import {
  isChannelTimelineRow,
  isTaskTransitionRow,
} from "./channelTimelineRows.ts";

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const ROOT = "a".repeat(64);

function transition(tags, overrides = {}) {
  return {
    id: "t1",
    kind: KIND_SYSTEM_MESSAGE,
    pubkey: "relay",
    created_at: 1_000,
    content: JSON.stringify({
      type: "task_created",
      task: "task-copy",
      title: "Write homepage copy",
      team: "team-marketing",
    }),
    tags,
    ...overrides,
  };
}

test("an unanchored task transition is not a channel timeline row", () => {
  assert.equal(isChannelTimelineRow(transition([["h", CHANNEL]])), false);
});

// The row the owner actually saw in production on 0.16.5: the relay anchors a
// transition with a lone `root` marker, which `getThreadReference` reads as
// "no parent", so the channel window placed it at channel level between real
// messages. Anchoring is no longer an escape hatch.
test("a task transition anchored to a thread root is dropped too", () => {
  assert.equal(
    isChannelTimelineRow(
      transition([
        ["h", CHANNEL],
        ["e", ROOT, "", "root"],
      ]),
    ),
    false,
  );
});

test("a task transition anchored by a reply marker is dropped too", () => {
  assert.equal(
    isChannelTimelineRow(
      transition([
        ["h", CHANNEL],
        ["e", ROOT, "", "reply"],
      ]),
    ),
    false,
  );
});

test("a task transition with root and reply markers is dropped too", () => {
  assert.equal(
    isChannelTimelineRow(
      transition([
        ["h", CHANNEL],
        ["e", ROOT, "", "root"],
        ["e", ROOT, "", "reply"],
      ]),
    ),
    false,
  );
});

test("a bare `e` tag does not rescue a transition either", () => {
  assert.equal(
    isChannelTimelineRow(
      transition([
        ["h", CHANNEL],
        ["e", ROOT],
      ]),
    ),
    false,
  );
});

test("other system rows are untouched by the transition rule", () => {
  // A join/leave row carries no task transition payload and belongs in the
  // channel timeline exactly as before.
  assert.equal(
    isChannelTimelineRow(
      transition([["h", CHANNEL]], {
        content: JSON.stringify({ type: "member_joined" }),
      }),
    ),
    true,
  );
  assert.equal(
    isChannelTimelineRow(transition([["h", CHANNEL]], { content: "not json" })),
    true,
  );
});

test("the task transition predicate keys on kind and payload type only", () => {
  assert.equal(isTaskTransitionRow(transition([["h", CHANNEL]])), true);
  assert.equal(
    isTaskTransitionRow(
      transition([["h", CHANNEL]], {
        content: JSON.stringify({ type: "member_joined" }),
      }),
    ),
    false,
  );
  assert.equal(
    isTaskTransitionRow(transition([["h", CHANNEL]], { content: "not json" })),
    false,
  );
  assert.equal(
    isTaskTransitionRow(
      transition([["h", CHANNEL]], { kind: KIND_STREAM_MESSAGE_V2 }),
    ),
    false,
  );
});

test("ordinary messages and non-timeline kinds are decided by kind alone", () => {
  assert.equal(
    isChannelTimelineRow({
      id: "m1",
      kind: KIND_STREAM_MESSAGE_V2,
      pubkey: "author",
      created_at: 1_000,
      content: "hello",
      tags: [["h", CHANNEL]],
    }),
    true,
  );
  assert.equal(
    isChannelTimelineRow({
      id: "r1",
      kind: 7,
      pubkey: "author",
      created_at: 1_000,
      content: "+",
      tags: [["h", CHANNEL]],
    }),
    false,
  );
});
