import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_TASK_TITLE_LEN, validateNewTaskInput } from "./newTaskModel.ts";

test("a missing channel is rejected before the title is even checked", () => {
  const result = validateNewTaskInput({
    channelId: "",
    title: "",
    assigneePersonaId: "",
  });
  assert.deepEqual(result, {
    ok: false,
    message: "Choose a channel for this task.",
  });
});

test("a blank title is rejected once a channel is chosen", () => {
  const result = validateNewTaskInput({
    channelId: "general",
    title: "   ",
    assigneePersonaId: "persona-1",
  });
  assert.deepEqual(result, { ok: false, message: "Give this task a title." });
});

test("a title over the cap is rejected", () => {
  const result = validateNewTaskInput({
    channelId: "general",
    title: "x".repeat(MAX_TASK_TITLE_LEN + 1),
    assigneePersonaId: "persona-1",
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /too long/i);
});

test("a title exactly at the cap is accepted", () => {
  const title = "x".repeat(MAX_TASK_TITLE_LEN);
  const result = validateNewTaskInput({
    channelId: "general",
    title,
    assigneePersonaId: "persona-1",
  });
  assert.deepEqual(result, {
    ok: true,
    title,
    assigneePersonaId: "persona-1",
    watcherPersonaIds: [],
  });
});

test("a valid submission trims surrounding whitespace", () => {
  const result = validateNewTaskInput({
    channelId: "general",
    title: "  Ship the thing  ",
    assigneePersonaId: "persona-1",
  });
  assert.deepEqual(result, {
    ok: true,
    title: "Ship the thing",
    assigneePersonaId: "persona-1",
    watcherPersonaIds: [],
  });
});

test("a task with no assignee is rejected", () => {
  const result = validateNewTaskInput({
    channelId: "general",
    title: "Respond with Hello World",
    assigneePersonaId: "",
  });
  assert.deepEqual(result, {
    ok: false,
    message: "Choose who does this task.",
  });
});

test("the assignee is not repeated among the watchers", () => {
  const result = validateNewTaskInput({
    channelId: "general",
    title: "Ship it",
    assigneePersonaId: "persona-1",
    watcherPersonaIds: ["persona-1", "persona-2", "persona-2", ""],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.watcherPersonaIds, ["persona-2"]);
});
