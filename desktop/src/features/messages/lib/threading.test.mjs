import assert from "node:assert/strict";
import test from "node:test";

import {
  KIND_STREAM_MESSAGE_V2,
  KIND_SYSTEM_MESSAGE,
} from "@/shared/constants/kinds";

import { getEventThreadReference, getThreadReference } from "./threading.ts";

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const ROOT = "a".repeat(64);
const PARENT = "b".repeat(64);

function event(kind, tags, content) {
  return {
    id: "e1",
    kind,
    pubkey: "relay",
    created_at: 1_000,
    content,
    tags,
  };
}

function taskRow(tags) {
  return event(
    KIND_SYSTEM_MESSAGE,
    tags,
    JSON.stringify({
      type: "task_created",
      task: "task-copy",
      title: "Write homepage copy",
      team: "team-marketing",
    }),
  );
}

test("a lone root marker is not a reply for an ordinary message", () => {
  // This client marks a direct reply to a root with a lone `reply` marker, so
  // a lone `root` marker means the event is not a reply. Unchanged.
  const tags = [
    ["h", CHANNEL],
    ["e", ROOT, "", "root"],
  ];
  assert.deepEqual(getThreadReference(tags), {
    parentId: null,
    rootId: null,
  });
  assert.deepEqual(
    getEventThreadReference(event(KIND_STREAM_MESSAGE_V2, tags, "hello")),
    { parentId: null, rootId: null },
  );
});

test("a task transition with a lone root marker replies to that root", () => {
  assert.deepEqual(
    getEventThreadReference(
      taskRow([
        ["h", CHANNEL],
        ["e", ROOT, "", "root"],
      ]),
    ),
    { parentId: ROOT, rootId: ROOT },
  );
});

test("a task transition carrying a reply marker never reaches the fallback", () => {
  assert.deepEqual(
    getEventThreadReference(
      taskRow([
        ["h", CHANNEL],
        ["e", ROOT, "", "root"],
        ["e", PARENT, "", "reply"],
      ]),
    ),
    { parentId: PARENT, rootId: ROOT },
  );
  assert.deepEqual(
    getEventThreadReference(
      taskRow([
        ["h", CHANNEL],
        ["e", ROOT, "", "reply"],
      ]),
    ),
    { parentId: ROOT, rootId: ROOT },
  );
});

test("an unanchored task transition still has no thread", () => {
  assert.deepEqual(getEventThreadReference(taskRow([["h", CHANNEL]])), {
    parentId: null,
    rootId: null,
  });
  assert.deepEqual(
    getEventThreadReference(
      taskRow([
        ["h", CHANNEL],
        ["e", ROOT],
      ]),
    ),
    { parentId: null, rootId: null },
  );
});

test("a non-transition system row keeps the ordinary reading", () => {
  assert.deepEqual(
    getEventThreadReference(
      event(
        KIND_SYSTEM_MESSAGE,
        [
          ["h", CHANNEL],
          ["e", ROOT, "", "root"],
        ],
        JSON.stringify({ type: "member_joined" }),
      ),
    ),
    { parentId: null, rootId: null },
  );
});
