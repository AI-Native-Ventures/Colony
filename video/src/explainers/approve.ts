import type { CursorKey } from "../launch/app/cursorPath.ts";

export type Rect = { x: number; y: number; w: number; h: number };

/** The owner's pointer for a yes beat: in from the lower right, onto the button, a short rest after the click. */
export function approveKeys(
  button: Rect,
  timing: { cursorFrom: number; click: number },
  from = { x: 1730, y: 960 },
): CursorKey[] {
  const x = button.x + button.w * 0.56;
  const y = button.y + button.h * 0.58;
  return [
    { at: timing.cursorFrom, x: from.x, y: from.y },
    { at: timing.click - 0.15, x, y },
    { at: timing.click + 0.7, x: x + 10, y: y + 8 },
  ];
}
