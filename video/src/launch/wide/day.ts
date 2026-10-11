import { clamp01 } from "../math.ts";
import type { EmployeeId } from "./employees.ts";

/** The working day the clock runs through, in hours. */
export const DAY_START = 7;
export const DAY_END = 18;

/** The time ruler, panel pixels. */
export const RULER = { x0: 260, x1: 1800 };

/** The team's four lanes, one per employee, panel pixels. */
export const DAY_LANE_TOP = 556;
export const DAY_LANE_STEP = 80;
export const DAY_CHIP_H = 58;

/** Top of lane `k` (team order). */
export function dayLaneY(k: number): number {
  return DAY_LANE_TOP + k * DAY_LANE_STEP;
}

/** Where lane `k`'s ant walks, just ahead of the clock line at `hour`. */
export function dayAntSpot(k: number, hour: number): { x: number; y: number } {
  return { x: hourX(hour) + 36, y: dayLaneY(k) + DAY_CHIP_H / 2 };
}

export type DayTiming = {
  clockFrom: number;
  clockTo: number;
  summaryAt: number;
};

/** Ruler x for an hour of the day. */
export function hourX(hour: number): number {
  return (
    RULER.x0 +
    ((hour - DAY_START) / (DAY_END - DAY_START)) * (RULER.x1 - RULER.x0)
  );
}

/** Hour of the day on the clock at film time `t`. */
export function clockHours(t: number, timing: DayTiming): number {
  const k = clamp01(
    (t - timing.clockFrom) / (timing.clockTo - timing.clockFrom),
  );
  return DAY_START + k * (DAY_END - DAY_START);
}

/** The clock face, in quarter hours so it can be read while it runs. */
export function clockLabel(t: number, timing: DayTiming): string {
  const quarters = Math.floor(clockHours(t, timing) * 4 + 1e-9);
  const h = Math.floor(quarters / 4);
  const m = (quarters % 4) * 15;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export type YouBlock = { from: number; to: number; text: string };

/** The owner's own day: the work they love. */
export const YOU_BLOCKS: YouBlock[] = [
  { from: 8, to: 11.5, text: "Geyser repair, Rosebank" },
  { from: 12.5, to: 15.75, text: "Burst pipe, Sandton" },
  { from: 16.5, to: 18, text: "Home early" },
];

export type TeamChip = { who: EmployeeId; at: number; text: string };

/** What the team got done meanwhile, each in its own lane, in the order it happened. */
export const TEAM_CHIPS: TeamChip[] = [
  { who: "blue", at: 9.0, text: "6 new customers" },
  { who: "amber", at: 9.75, text: "6 emails sent" },
  { who: "pink", at: 11.0, text: "Posted on Instagram" },
  { who: "green", at: 12.0, text: "Prices updated" },
  { who: "amber", at: 12.5, text: "4 calls made" },
  { who: "blue", at: 14.0, text: "5 more customers" },
  { who: "amber", at: 15.5, text: "2 meetings booked" },
  { who: "pink", at: 16.25, text: "Next week planned" },
  { who: "green", at: 17.25, text: "New reviews added" },
];

/** Rough chip width at 22 px: icon and padding plus the text. */
export function chipWidth(text: string): number {
  return 72 + text.length * 12.5;
}

/** Film time a chip appears: when the clock reaches its hour. */
export function chipShowsAt(chip: TeamChip, timing: DayTiming): number {
  const k = (chip.at - DAY_START) / (DAY_END - DAY_START);
  return timing.clockFrom + k * (timing.clockTo - timing.clockFrom);
}

/** A chip trails its ant: it ends where the clock is when it appears. */
export function chipLeft(chip: TeamChip): number {
  return hourX(chip.at) - chipWidth(chip.text);
}
