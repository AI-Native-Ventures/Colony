import { easeInOutCubic, progress } from "../launch/math.ts";
import type { Box, ShotId } from "./manifest.ts";

/** Where a claim's real screen sits: the right of the frame, above the captions. */
export const AREA = { x: 820, y: 100, w: 1000, h: 770 } as const;

/** App pixels of the screen kept around a region, so it never ends on a cut edge. */
const MARGIN = 12;
/** The most a region is magnified. */
const MAX_SCALE = 2.2;
/** The most the card moves closer to what it points at, and the room it keeps around it. */
const PUSH = 1.35;
const ROOM = 40;
/** How long the card takes to move to a new look. */
const MOVE_SECONDS = 0.8;

/** A card showing `view` (app pixels) at `scale`, drawn at `card` (frame pixels). */
export type Layout = { card: Box; view: Box; scale: number };

/** Inside the card: the app point at its centre, and how much closer than the layout it is. */
export type Look = { x: number; y: number; zoom: number };

/** The card for `region` of a `screen`-sized shot: as large as fits the area, centred in it. */
export function layoutFor(
  region: Box,
  screen: { w: number; h: number },
): Layout {
  const left = Math.max(0, region.x - MARGIN);
  const top = Math.max(0, region.y - MARGIN);
  const right = Math.min(screen.w, region.x + region.w + MARGIN);
  const bottom = Math.min(screen.h, region.y + region.h + MARGIN);
  const view = { x: left, y: top, w: right - left, h: bottom - top };
  const scale = Math.min(MAX_SCALE, AREA.w / view.w, AREA.h / view.h);
  const w = view.w * scale;
  const h = view.h * scale;
  return {
    card: { x: AREA.x + (AREA.w - w) / 2, y: AREA.y + (AREA.h - h) / 2, w, h },
    view,
    scale,
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** The look that shows the whole view, or moves closer to a small `focus` while keeping it all in the card. */
export function lookAt(layout: Layout, focus: Box | null): Look {
  const { view } = layout;
  // Only a small part, like a button, is worth moving closer to: anything
  // wider already reads at the card's size, and closer would cut its row short.
  if (!focus || focus.w > view.w / 4 || focus.h > view.h / 4)
    return { x: view.x + view.w / 2, y: view.y + view.h / 2, zoom: 1 };
  const zoom = clamp(
    Math.min(view.w / (focus.w + 2 * ROOM), view.h / (focus.h + 2 * ROOM)),
    1,
    PUSH,
  );
  const halfW = view.w / 2 / zoom;
  const halfH = view.h / 2 / zoom;
  return {
    x: clamp(focus.x + focus.w / 2, view.x + halfW, view.x + view.w - halfW),
    y: clamp(focus.y + focus.h / 2, view.y + halfH, view.y + view.h - halfH),
    zoom,
  };
}

function towards(a: number, b: number, e: number): number {
  return e >= 1 ? b : a + (b - a) * e;
}

/** The look at `t`: each key's look eased in over MOVE_SECONDS from its time. */
export function lookAtTime(
  t: number,
  keys: readonly { at: number; look: Look }[],
): Look {
  let look = keys[0].look;
  for (let i = 1; i < keys.length; i++) {
    const key = keys[i];
    if (t < key.at) break;
    const e = easeInOutCubic(progress(t, key.at, MOVE_SECONDS));
    look = {
      x: towards(look.x, key.look.x, e),
      y: towards(look.y, key.look.y, e),
      zoom: towards(look.zoom, key.look.zoom, e),
    };
  }
  return look;
}

/** One claim's turn on a proof card: its shot, the part shown, and what it points at. */
export type ProofStep = {
  id: string;
  shot: ShotId;
  from: number;
  to: number;
  region: Box;
  focus: Box | null;
  screen: { w: number; h: number };
};

/** A card held across claims in a row that show the same part of the screen. */
export type ProofGroup = {
  layout: Layout;
  from: number;
  to: number;
  steps: ProofStep[];
};

/** Two boxes the same to half a pixel. */
export function sameBox(a: Box, b: Box): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.w - b.w) < 0.5 &&
    Math.abs(a.h - b.h) < 0.5
  );
}

/** The claims' cards: a claim showing the same part as the one before keeps its card. */
export function proofGroups(steps: readonly ProofStep[]): ProofGroup[] {
  const groups: ProofGroup[] = [];
  for (const step of steps) {
    const group = groups[groups.length - 1];
    const before = group?.steps[group.steps.length - 1];
    if (
      group &&
      before &&
      sameBox(before.region, step.region) &&
      before.screen.w === step.screen.w &&
      before.screen.h === step.screen.h &&
      Math.abs(before.to - step.from) < 1e-6
    ) {
      group.steps.push(step);
      group.to = step.to;
    } else {
      groups.push({
        layout: layoutFor(step.region, step.screen),
        from: step.from,
        to: step.to,
        steps: [step],
      });
    }
  }
  return groups;
}
