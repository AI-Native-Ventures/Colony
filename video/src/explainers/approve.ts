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

/** The owner's pointer ticking boxes in order: onto each box just before its click, on to the next after. */
export function tickKeys(
  boxes: readonly Rect[],
  clicks: readonly number[],
  cursorFrom: number,
  from = { x: 1790, y: 1010 },
): CursorKey[] {
  const keys: CursorKey[] = [{ at: cursorFrom, x: from.x, y: from.y }];
  boxes.forEach((b, i) => {
    const x = b.x + b.w * 0.56;
    const y = b.y + b.h * 0.6;
    keys.push({ at: clicks[i] - 0.09, x, y });
    keys.push({ at: clicks[i] + 0.05, x, y });
  });
  return keys;
}

/** The owner's pointer coming to rest on a button it has not pressed yet. */
export function restKeys(
  button: Rect,
  timing: { restFrom: number; restAt: number },
  from = { x: 1100, y: 1010 },
): CursorKey[] {
  return [
    { at: timing.restFrom, x: from.x, y: from.y },
    {
      at: timing.restAt,
      x: button.x + button.w * 0.56,
      y: button.y + button.h * 0.58,
    },
  ];
}
