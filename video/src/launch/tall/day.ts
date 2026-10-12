import type { Box } from "./frame.ts";
import { DAY_END, DAY_START, type TeamChip } from "../wide/day.ts";
import type { EmployeeId } from "../wide/employees.ts";

/**
 * Your day on the tall frame: the clock on top, the hours running down the
 * page, your jobs in the left column, your team's wins in the right one.
 */
export const TALL_DAY = {
  clock: { x: 58, y: 296, size: 136 },
  weekday: { x: 506, y: 374, size: 34 },
  heads: { y: 478 },
  ruler: { x: 148, top: 580, bottom: 1240 },
  you: { x: 168, w: 262 },
  team: { x: 462, w: 478 },
  chip: { h: 56, gap: 8, font: 22 },
  block: { pad: 18, lineHeight: 30, font: 24 },
  summary: { y: 1306, label: 32, gap: 8, row: 62, rowGap: 12, font: 28 },
} as const;

const D = TALL_DAY;

/** How far below the clock line the team's ants walk. */
const ANT_DROP = 28;

/** Y of an hour of the day, on the page. */
export function hourY(hour: number): number {
  return (
    D.ruler.top +
    ((hour - DAY_START) / (DAY_END - DAY_START)) *
      (D.ruler.bottom - D.ruler.top)
  );
}

/**
 * Each chip's top: it ends at its own time, just behind the ants walking
 * down, and is pushed up when the next one would touch it. `chips` are in
 * time order.
 */
export function chipTops(chips: readonly TeamChip[]): number[] {
  const tops = chips.map((chip) => hourY(chip.at) - D.chip.h);
  for (let i = tops.length - 2; i >= 0; i--) {
    tops[i] = Math.min(tops[i], tops[i + 1] - D.chip.h - D.chip.gap);
  }
  return tops;
}

/** Where team member `k`'s ant walks, side by side across the team column, just under the line at `hour`. */
export function tallDayAntSpot(
  k: number,
  hour: number,
): { x: number; y: number } {
  return { x: D.team.x + 60 + k * 110, y: hourY(hour) + ANT_DROP };
}

/** A job's words in lines that fit its block (0.55 em a character, Inter 650). */
export function youBlockLines(text: string): string[] {
  const max = Math.floor((D.you.w - 2 * D.block.pad) / (D.block.font * 0.55));
  const lines: string[] = [];
  for (const word of text.split(" ")) {
    const last = lines.length - 1;
    if (last >= 0 && `${lines[last]} ${word}`.length <= max) {
      lines[last] = `${lines[last]} ${word}`;
    } else {
      lines.push(word);
    }
  }
  return lines;
}

export type SummaryItem = { who: EmployeeId; text: string };

/** The film's "Today" results, two to a row. */
export const SUMMARY_ROWS: readonly (readonly SummaryItem[])[] = [
  [
    { who: "blue", text: "11 new customers" },
    { who: "amber", text: "2 meetings booked" },
  ],
  [
    { who: "pink", text: "4 posts" },
    { who: "green", text: "Website updated" },
  ],
];

/** The summary: "Today" and two rows of results, centred under 18:00. */
export function summaryBox(): Box {
  const s = D.summary;
  return {
    x: 140,
    y: s.y,
    w: 800,
    h: s.label + s.gap + 2 * s.row + s.rowGap,
  };
}
