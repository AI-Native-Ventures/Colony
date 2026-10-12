import type { CursorKey } from "../launch/app/cursorPath.ts";
import type { CameraKey } from "./camera.ts";
import { type Box, type Manifest, type ShotId, unionBox } from "./manifest.ts";
import { toFrame, WINDOW } from "./stage.ts";
import type { Move, UserBeat } from "./startHereBeats.ts";
import type { Timeline } from "./timeline.ts";

/** Seconds from a move's start to its click: after the camera has settled. */
export const CLICK_AFTER = 1;

/** Seconds a new shot takes to fade in over the one before. */
export const SHOT_FADE = 0.3;

/** A move at its second in the video. */
export type Placed = { at: number; beat: string; move: Move };

/** Every beat's moves at their seconds in the video, in order. */
export function placeMoves(beats: readonly UserBeat[], tl: Timeline): Placed[] {
  const out: Placed[] = [];
  for (const beat of beats) {
    const span = tl.beats.find((b) => b.id === beat.id);
    if (!span) throw new Error(`no time for beat "${beat.id}"`);
    for (const move of beat.moves)
      out.push({
        at: span.from + move.at * (span.to - span.from),
        beat: beat.id,
        move,
      });
  }
  return out;
}

/** What a move looks at, in frame pixels at rest. */
export function focusBox(move: Move, manifest: Manifest): Box {
  if (move.focus === "window") return WINDOW;
  const shot = manifest.shots[move.shot];
  return toFrame(unionBox(move.focus.map((name) => shot.boxes[name])));
}

/** The camera's keys: one per move. */
export function cameraKeys(
  placed: readonly Placed[],
  manifest: Manifest,
): CameraKey[] {
  return placed.map((p) => ({
    at: p.at,
    focus: focusBox(p.move, manifest),
    zoom: p.move.zoom,
  }));
}

export type Click = { at: number; shot: ShotId; target: string };

/** Each click, at its second: CLICK_AFTER into its move. */
export function clicksOf(placed: readonly Placed[]): Click[] {
  return placed.flatMap((p) =>
    p.move.click
      ? [{ at: p.at + CLICK_AFTER, shot: p.move.shot, target: p.move.click }]
      : [],
  );
}

/**
 * The pointer's path in stage pixels (the frame at rest): from where it last
 * was to each click's target, arriving just before it clicks.
 */
export function pointerKeys(
  clicks: readonly Click[],
  manifest: Manifest,
): CursorKey[] {
  const keys: CursorKey[] = [];
  let from = { x: WINDOW.x + WINDOW.w * 0.58, y: WINDOW.y + WINDOW.h * 0.55 };
  for (const click of clicks) {
    const box = toFrame(manifest.shots[click.shot].boxes[click.target]);
    const to = { x: box.x + box.w * 0.5, y: box.y + box.h * 0.55 };
    const last = keys[keys.length - 1]?.at ?? Number.NEGATIVE_INFINITY;
    keys.push({ at: Math.max(last + 0.01, click.at - 0.7), ...from });
    keys.push({ at: click.at - 0.08, ...to });
    from = to;
  }
  return keys;
}

/** The shot on screen at `t`, and the one it is fading in over. */
export function shotAt(
  placed: readonly Placed[],
  t: number,
): { shot: ShotId; previous?: ShotId; mix: number } {
  let i = 0;
  for (let k = 0; k < placed.length; k++) if (placed[k].at <= t) i = k;
  const shot = placed[i].move.shot;
  let start = i;
  while (start > 0 && placed[start - 1].move.shot === shot) start--;
  if (start === 0) return { shot, mix: 1 };
  const mix = Math.min(1, Math.max(0, (t - placed[start].at) / SHOT_FADE));
  return { shot, previous: placed[start - 1].move.shot, mix };
}
