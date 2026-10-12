import { APP_VIEWPORT, type Box } from "./manifest.ts";

/** The user videos' frame, 16:9. */
export const FRAME = { w: 1920, h: 1080 } as const;

/** The wide subtitles start at 968; the camera keeps what it shows above this. */
export const CAPTION_TOP = 950;

/** The app window at rest: the 1440 x 900 capture, centred, above the captions. */
export const WINDOW: Box = { x: 270, y: 38, w: 1380, h: 862.5 };

/** App CSS pixels to frame pixels at rest. */
export const APP_SCALE = WINDOW.w / APP_VIEWPORT.w;

/** A box in app CSS pixels, where it sits on the frame at rest. */
export function toFrame(box: Box): Box {
  return {
    x: WINDOW.x + box.x * APP_SCALE,
    y: WINDOW.y + box.y * APP_SCALE,
    w: box.w * APP_SCALE,
    h: box.h * APP_SCALE,
  };
}
