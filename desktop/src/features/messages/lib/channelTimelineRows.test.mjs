import assert from "node:assert/strict";
import test from "node:test";

import {
  KIND_STREAM_MESSAGE_V2,
  KIND_SYSTEM_MESSAGE,
} from "@/shared/constants/kinds";

import { isChannelTimelineRow } from "./channelTimelineRows.ts";

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

test("a task transition anchored to a thread root stays a timeline row", () => {
  assert.equal(
    isChannelTimelineRow(
      transition([
        ["h", CHANNEL],
        ["e", ROOT, "", "root"],
      ]),
    ),
    true,
  );
});

test("a task transition anchored by a reply marker stays a timeline row", () => {
  assert.equal(
    isChannelTimelineRow(
      transition([
        ["h", CHANNEL],
        ["e", ROOT, "", "reply"],
      ]),
    ),
    true,
  );
});

test("a bare `e` tag with no marker does not anchor a transition", () => {
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
