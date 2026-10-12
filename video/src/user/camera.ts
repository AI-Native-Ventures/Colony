import { easeInOutCubic, progress } from "../launch/math.ts";
import type { Box } from "./manifest.ts";
import { CAPTION_TOP, FRAME, WINDOW } from "./stage.ts";

/** The stage transform, origin top left: translate(x, y) scale(scale). */
export type Camera = { x: number; y: number; scale: number };

/** From `at`, the camera eases to look at `focus` (frame pixels at rest) at `zoom`. */
export type CameraKey = { at: number; focus: Box; zoom: number };

/** How long the camera takes to move to a new key. */
export const MOVE_SECONDS = 0.8;

/** What the camera shows: the whole width, down to the captions. */
const VIEW = { w: FRAME.w, h: CAPTION_TOP } as const;

/** Slide one axis so a window larger than the view leaves no backdrop gap. */
function fill(
  offset: number,
  start: number,
  size: number,
  scale: number,
  view: number,
): number {
  if (size * scale <= view) return offset;
  const near = start * scale + offset;
  const far = (start + size) * scale + offset;
  if (near > 0) return offset - near;
  if (far < view) return offset + (view - far);
  return offset;
}

/** The camera that centres `focus` in the view at `zoom`, sliding back where the window would leave a gap. */
export function frameFor(focus: Box, zoom: number): Camera {
  const cx = focus.x + focus.w / 2;
  const cy = focus.y + focus.h / 2;
  return {
    x: fill(VIEW.w / 2 - cx * zoom, WINDOW.x, WINDOW.w, zoom, VIEW.w),
    y: fill(VIEW.h / 2 - cy * zoom, WINDOW.y, WINDOW.h, zoom, VIEW.h),
    scale: zoom,
  };
}

function towards(a: number, b: number, e: number): number {
  return e >= 1 ? b : a + (b - a) * e;
}

/** The camera at `t`: each key's focus and zoom eased in over MOVE_SECONDS from its time. */
export function cameraAt(t: number, keys: readonly CameraKey[]): Camera {
  let focus = keys[0].focus;
  let zoom = keys[0].zoom;
  for (let i = 1; i < keys.length; i++) {
    const key = keys[i];
    if (t < key.at) break;
    const e = easeInOutCubic(progress(t, key.at, MOVE_SECONDS));
    focus = {
      x: towards(focus.x, key.focus.x, e),
      y: towards(focus.y, key.focus.y, e),
      w: towards(focus.w, key.focus.w, e),
      h: towards(focus.h, key.focus.h, e),
    };
    zoom = towards(zoom, key.zoom, e);
  }
  return frameFor(focus, zoom);
}

/** Where a stage point lands on the frame. */
export function project(
  p: { x: number; y: number },
  cam: Camera,
): { x: number; y: number } {
  return { x: p.x * cam.scale + cam.x, y: p.y * cam.scale + cam.y };
}

/** Where a stage box lands on the frame. */
export function projectBox(box: Box, cam: Camera): Box {
  const { x, y } = project(box, cam);
  return { x, y, w: box.w * cam.scale, h: box.h * cam.scale };
}
