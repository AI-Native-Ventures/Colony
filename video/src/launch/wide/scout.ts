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
const ROW_STEP = 124;

/** Centre of the "From Scout" badge, top right of the card: where every task comes from. */
export function scoutNode(): Point {
  return { x: SCOUT_CARD.x + SCOUT_CARD.w - 170, y: SCOUT_CARD.y + 86 };
}

/** Centre of employee `i`'s avatar, down the left of the card. */
export function employeeNode(i: number): Point {
  return {
    x: SCOUT_CARD.x + 52 + 34,
    y: SCOUT_CARD.y + ROW_TOP + i * ROW_STEP,
  };
}

/** Where task `i`'s card lands: its left edge just right of its employee. */
export function taskSpot(i: number): Point {
  const node = employeeNode(i);
  return { x: node.x + 62, y: node.y };
}

/** A dealt task card's width, panel pixels. */
export const TASK_CARD_W = 690;

/** Where task `i`'s card centre lands. */
export function taskCenter(i: number): Point {
  const spot = taskSpot(i);
  return { x: spot.x + TASK_CARD_W / 2, y: spot.y };
}

/** The arc a task card's centre is dealt along, from Scout's badge down into its row. */
export function taskPath(i: number): Path {
  const from = scoutNode();
  const to = taskCenter(i);
  return [
    from,
    { x: from.x - 60, y: from.y + 60 },
    { x: to.x + 80, y: to.y - 70 },
    to,
  ];
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
