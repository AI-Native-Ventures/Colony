import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_TASK_TITLE_LEN, validateNewTaskInput } from "./newTaskModel.ts";

test("a missing channel is rejected before the title is even checked", () => {
  const result = validateNewTaskInput({ channelId: "", title: "" });
  assert.deepEqual(result, {
    ok: false,
    message: "Choose a channel for this task.",
  });
});

test("a blank title is rejected once a channel is chosen", () => {
  const result = validateNewTaskInput({ channelId: "general", title: "   " });
  assert.deepEqual(result, { ok: false, message: "Give this task a title." });
});

test("a title over the cap is rejected", () => {
  const result = validateNewTaskInput({
    channelId: "general",
    title: "x".repeat(MAX_TASK_TITLE_LEN + 1),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /too long/i);
});

test("a title exactly at the cap is accepted", () => {
  const title = "x".repeat(MAX_TASK_TITLE_LEN);
  const result = validateNewTaskInput({ channelId: "general", title });
  assert.deepEqual(result, { ok: true, title });
});

test("a valid submission trims surrounding whitespace", () => {
  const result = validateNewTaskInput({
    channelId: "general",
    title: "  Ship the thing  ",
  });
  assert.deepEqual(result, { ok: true, title: "Ship the thing" });
});
