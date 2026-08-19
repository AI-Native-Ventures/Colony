import assert from "node:assert/strict";
import test from "node:test";

import { selectBufferedTimelineMessages } from "./useBufferedTimelineMessages.ts";

const rows = (...ids) => ids.map((id) => ({ id }));

test("freezes live arrivals after the semantic tail while scrolled up", () => {
  assert.deepEqual(
    selectBufferedTimelineMessages({
      frozenMessageIds: ["a", "b", "c"],
      isAtBottom: false,
      messages: rows("a", "b", "c", "d", "e"),
    }).map(({ id }) => id),
    ["a", "b", "c"],
  );
});

test("admits older-history prepends without exposing buffered arrivals", () => {
  assert.deepEqual(
    selectBufferedTimelineMessages({
      frozenMessageIds: ["a", "b", "c"],
      isAtBottom: false,
      messages: rows("older-a", "older-b", "a", "b", "c", "d"),
    }).map(({ id }) => id),
    ["older-a", "older-b", "a", "b", "c"],
  );
});

test("releases the full logical dataset at bottom", () => {
  const messages = rows("a", "b", "c", "d");
  assert.deepEqual(
    selectBufferedTimelineMessages({
      frozenMessageIds: ["a", "b"],
      isAtBottom: true,
      messages,
    }),
    messages,
  );
});

test("accepts an authoritative replacement when its old tail disappeared", () => {
  const messages = rows("x", "y");
  assert.deepEqual(
    selectBufferedTimelineMessages({
      frozenMessageIds: ["old-tail"],
      isAtBottom: false,
      messages,
    }),
    messages,
  );
});

test("does not duplicate a frozen row that reorders ahead of the frozen head", () => {
  // Same-second events can swap places between two projections of the same
  // data. A frozen id that moves ahead of `frozenMessageIds[0]` must not be
  // emitted twice: the timeline renders one row per array entry, so a repeat
  // is a visible duplicate message.
  assert.deepEqual(
    selectBufferedTimelineMessages({
      frozenMessageIds: ["a", "b"],
      isAtBottom: false,
      messages: rows("b", "a"),
    }).map(({ id }) => id),
    ["a", "b"],
  );
});

test("keeps a reordered prepend without repeating the frozen tail", () => {
  assert.deepEqual(
    selectBufferedTimelineMessages({
      frozenMessageIds: ["a", "b", "c"],
      isAtBottom: false,
      messages: rows("older", "c", "a", "b", "live"),
    }).map(({ id }) => id),
    ["older", "a", "b", "c"],
  );
});
