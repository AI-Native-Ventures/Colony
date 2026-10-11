import { mulberry32 } from "../math.ts";
import { type Point, pickPoints } from "../points.ts";
import { type Ant, createAnts, type Lane } from "../swarm.ts";
import { WIDE_W } from "./beat.ts";
import { DAY_END, dayAntSpot } from "./day.ts";
import { type EmployeeId, TEAM } from "./employees.ts";
import { CLOSE90 } from "./film90.ts";

/** colors.ts GROUP_RGB index per employee: the logo's slices, left to right. */
export const GROUP_OF: Record<EmployeeId, number> = {
  blue: 0,
  amber: 1,
  green: 2,
  pink: 3,
};

const PER_EMPLOYEE = 160;
const CLOSE_SEED = 20261012;

/** Up from the end of the day and over into each employee's part of the logo. */
const CLOSE_LANES: Record<EmployeeId, Lane> = {
  blue: { c1: { x: 1500, y: 60 }, c2: { x: 700, y: 120 }, spread: 110 },
  amber: { c1: { x: 1560, y: 140 }, c2: { x: 860, y: 40 }, spread: 110 },
  green: { c1: { x: 1640, y: 220 }, c2: { x: 1180, y: 20 }, spread: 110 },
  pink: { c1: { x: 1720, y: 320 }, c2: { x: 1300, y: 80 }, spread: 110 },
};

/**
 * The close swarm, in screen pixels (the camera rests on the day panel): each
 * employee's ants leave from where it walked the day and build its own slice
 * of the logo, as in the opening. `logo` is the sampled mark at CLOSE_LOGO.
 */
export function closeSwarmAnts(logo: Point[]): Ant[] {
  const rand = mulberry32(CLOSE_SEED);
  const sorted = [...logo].sort((a, b) => a.x - b.x || a.y - b.y);
  const ants: Ant[] = [];
  TEAM.forEach((who, k) => {
    const g = GROUP_OF[who];
    const slice = sorted.slice(
      Math.floor((g * sorted.length) / 4),
      Math.floor(((g + 1) * sorted.length) / 4),
    );
    const ends = pickPoints(slice, PER_EMPLOYEE, rand);
    const home = dayAntSpot(k, DAY_END);
    const starts: Point[] = Array.from({ length: PER_EMPLOYEE }, () => ({
      x: home.x - 30 + rand() * 50,
      y: home.y - 22 + rand() * 44,
    }));
    const made = createAnts(starts, ends, [CLOSE_LANES[who]], {
      seed: CLOSE_SEED + 1 + g,
      releaseAt: CLOSE90.dimFrom + 0.1 + k * 0.08,
      sweep: 0,
      frameWidth: WIDE_W,
      flight: { min: 1.15, spread: 0.3 },
    });
    for (const ant of made) ants.push({ ...ant, group: g });
  });
  return ants;
}
