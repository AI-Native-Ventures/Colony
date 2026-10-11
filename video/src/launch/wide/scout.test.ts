import assert from "node:assert/strict";
import { test } from "node:test";
import { TEAM } from "./employees.ts";
import {
  employeeNode,
  SCOUT_CARD,
  SCOUT_TASKS,
  scoutNode,
  TASK_CARD_W,
  taskCenter,
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

test("Scout deals each task into its own row, beside its employee", () => {
  SCOUT_TASKS.forEach((_, i) => {
    const path = taskPath(i);
    assert.deepEqual(path[0], scoutNode());
    assert.deepEqual(path[3], taskCenter(i));
    assert.equal(taskCenter(i).x, taskSpot(i).x + TASK_CARD_W / 2);
    assert.equal(taskSpot(i).y, employeeNode(i).y);
    assert.ok(
      taskSpot(i).x > employeeNode(i).x,
      "task sits right of its avatar",
    );
  });
});

test("rows are big and never overlap, and the plan fits the card", () => {
  for (let i = 1; i < SCOUT_TASKS.length; i++) {
    assert.ok(employeeNode(i).y - employeeNode(i - 1).y >= 110);
  }
  const last = employeeNode(SCOUT_TASKS.length - 1);
  assert.ok(last.y + 50 <= SCOUT_CARD.y + SCOUT_CARD.h - 80);
});
