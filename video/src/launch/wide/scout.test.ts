import assert from "node:assert/strict";
import { test } from "node:test";
import { TEAM } from "./employees.ts";
import {
  employeeNode,
  SCOUT_TASKS,
  scoutNode,
  taskLandsAt,
  taskPath,
  taskSpot,
} from "./scout.ts";

const timing = { taskFrom: 10, taskEvery: 0.5, taskDuration: 0.9 };

test("Scout hands one task to each employee, in team order", () => {
  assert.deepEqual(
    SCOUT_TASKS.map((task) => task.who),
    [...TEAM],
  );
});

test("each task is short enough to read on its card", () => {
  for (const task of SCOUT_TASKS) {
    assert.ok(task.text.length <= 34, `"${task.text}" is too long`);
  }
});

test("tasks land one after another", () => {
  for (let i = 1; i < SCOUT_TASKS.length; i++) {
    assert.ok(taskLandsAt(i, timing) > taskLandsAt(i - 1, timing));
  }
});

test("each task travels from Scout to a spot beside its own employee", () => {
  SCOUT_TASKS.forEach((_, i) => {
    const path = taskPath(i);
    assert.deepEqual(path[0], scoutNode());
    assert.deepEqual(path[3], taskSpot(i));
    assert.ok(taskSpot(i).x < employeeNode(i).x, "lands on its employee");
    assert.equal(taskSpot(i).y, employeeNode(i).y);
  });
});
