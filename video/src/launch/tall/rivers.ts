import type { Point } from "../points.ts";
import { type EmployeeId, TONES } from "../wide/employees.ts";
import { type PanelId, TIMING90, YES90 } from "../wide/film90.ts";
import type { RiverSpec } from "../wide/riverAnts.ts";
import { employeeNode } from "../wide/scout.ts";
import { approvedAt, YES_CARD, YES_ROWS, yesRowY } from "../wide/yes.ts";
import { TALL_H, TALL_W, toTall } from "./frame.ts";
import { HERO } from "./hero.ts";
import { panelY } from "./scroll.ts";

/** A point on page `id`, in strip pixels (the pages stacked top to bottom). */
function onPage(id: PanelId, p: Point): Point {
  return { x: p.x, y: panelY(id) + p.y };
}

/** A film card point on page `id`, in strip pixels. */
function cardPoint(id: PanelId, p: Point): Point {
  return onPage(id, toTall(p));
}

type Shape = Pick<RiverSpec, "from" | "lane">;

/** One employee's river, its shape given in its own page's pixels. */
function employeeRiver(id: EmployeeId, seed: number, shape: Shape): RiverSpec {
  const y = panelY(id);
  const timing = TIMING90[id];
  return {
    color: TONES[id].rgb,
    seed,
    count: 140,
    from: {
      x0: shape.from.x0,
      x1: shape.from.x1,
      y0: shape.from.y0 + y,
      y1: shape.from.y1 + y,
    },
    lane: {
      c1: onPage(id, shape.lane.c1),
      c2: onPage(id, shape.lane.c2),
      spread: shape.lane.spread,
    },
    target: onPage(id, HERO.avatar),
    startAt: timing.riverFrom,
    landAt: timing.avatarAt,
    sweep: 0,
    flight: { min: 0.9, spread: 0.3 },
  };
}

const node = cardPoint("scout", employeeNode(0));

/**
 * Each employee arrives as a river of its color curling into its avatar,
 * as in the wide film: blue's leaves Scout's plan from the blue row, the
 * others come in from off the screen. Strip pixels. Blue's bends are set
 * low on the strip because the camera scrolls a whole page while it flies:
 * on screen it arcs up to the right and curls back into the avatar.
 */
export const TALL_RIVERS: Record<EmployeeId, RiverSpec> = {
  blue: {
    color: TONES.blue.rgb,
    seed: 7101,
    count: 160,
    from: {
      x0: node.x - 30,
      x1: node.x + 30,
      y0: node.y - 30,
      y1: node.y + 30,
    },
    lane: {
      c1: onPage("blue", { x: 900, y: 420 }),
      c2: onPage("blue", { x: 150, y: 660 }),
      spread: 130,
    },
    target: onPage("blue", HERO.avatar),
    startAt: TIMING90.blue.riverFrom,
    landAt: TIMING90.blue.avatarAt,
    sweep: 0,
    flight: { min: 0.9, spread: 0.3 },
  },
  amber: employeeRiver("amber", 7301, {
    from: { x0: 560, x1: 1000, y0: TALL_H + 60, y1: TALL_H + 220 },
    lane: { c1: { x: 1040, y: 1150 }, c2: { x: 380, y: 40 }, spread: 140 },
  }),
  pink: employeeRiver("pink", 7501, {
    from: { x0: TALL_W + 60, x1: TALL_W + 220, y0: 500, y1: 1100 },
    lane: { c1: { x: 700, y: 1300 }, c2: { x: -60, y: 900 }, spread: 140 },
  }),
  green: employeeRiver("green", 7701, {
    from: { x0: 60, x1: 480, y0: TALL_H + 60, y1: TALL_H + 220 },
    lane: { c1: { x: 1100, y: 1100 }, c2: { x: 760, y: -160 }, spread: 140 },
  }),
};

/** On Approve, each inbox row's work streams out to the right as a burst of its employee's ants. */
export const TALL_BURSTS: RiverSpec[] = YES_ROWS.map((row, i) => {
  const y = yesRowY(i);
  const start = approvedAt(i, YES90) + 0.02;
  const a = cardPoint("yes", { x: YES_CARD.x + 110, y: y + 14 });
  const b = cardPoint("yes", { x: YES_CARD.x + 700, y: y + 78 });
  return {
    color: TONES[row.who].rgb,
    seed: 7901 + i * 17,
    count: 56,
    from: { x0: a.x, x1: b.x, y0: a.y, y1: b.y },
    lane: {
      c1: cardPoint("yes", { x: 1560, y: y - 140 }),
      c2: cardPoint("yes", { x: 2060, y: y - 60 }),
      spread: 110,
    },
    target: cardPoint("yes", { x: 2400, y: y - 110 }),
    startAt: start,
    landAt: start + 1.05,
    sweep: 0,
    flight: { min: 0.75, spread: 0.35 },
  };
});
