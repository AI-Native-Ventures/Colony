import type { Point } from "../points.ts";
import type { EmployeeId } from "./employees.ts";
import type { Path } from "./walk.ts";

/** Today's plan: Scout, the chief of staff, hands each employee its job. Panel pixels. */
export const SCOUT_CARD = { x: 860, y: 150, w: 940, h: 760 };

export type ScoutTask = { who: EmployeeId; text: string };

export const SCOUT_TASKS: ScoutTask[] = [
  { who: "blue", text: "Find 20 office parks in Sandton" },
  { who: "amber", text: "Email and call each one" },
  { who: "pink", text: "Make 3 posts for this week" },
  { who: "green", text: "Put new prices on the website" },
];

const ROW_TOP = 236;
const ROW_STEP = 136;

/** Centre of Scout's avatar. */
export function scoutNode(): Point {
  return { x: SCOUT_CARD.x + 150, y: SCOUT_CARD.y + 440 };
}

/** Centre of employee `i`'s avatar, down the right of the card. */
export function employeeNode(i: number): Point {
  return {
    x: SCOUT_CARD.x + SCOUT_CARD.w - 92,
    y: SCOUT_CARD.y + ROW_TOP + i * ROW_STEP,
  };
}

/** Where task `i`'s card lands: its right edge just left of its employee. */
export function taskSpot(i: number): Point {
  const node = employeeNode(i);
  return { x: node.x - 62, y: node.y };
}

/** The trail a task travels from Scout to its employee. */
export function taskPath(i: number): Path {
  const from = scoutNode();
  const to = taskSpot(i);
  return [from, { x: from.x + 170, y: from.y }, { x: to.x - 260, y: to.y }, to];
}

export type TaskTiming = {
  taskFrom: number;
  taskEvery: number;
  taskDuration: number;
};

export function taskStartsAt(i: number, timing: TaskTiming): number {
  return timing.taskFrom + i * timing.taskEvery;
}

export function taskLandsAt(i: number, timing: TaskTiming): number {
  return taskStartsAt(i, timing) + timing.taskDuration;
}
