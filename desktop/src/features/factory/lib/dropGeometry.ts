/**
 * Drop zone geometry: which edge of a target pane (or its centre) a drag
 * point lands in.
 *
 * Each side owns a band 30% of that axis deep. Inside a band the nearest
 * edge wins, measured as a fraction of the axis so a wide pane's left band
 * competes fairly with a short pane's top band. Ties resolve in the order
 * left, right, top, bottom, which keeps corners on the horizontal split
 * people expect.
 */

export const EDGE_BAND_FRACTION = 0.3;

export type DropZone = "left" | "right" | "top" | "bottom" | "center";

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

export function resolveDropEdge(rect: Rect, point: Point): DropZone {
  if (rect.width <= 0 || rect.height <= 0) return "center";

  const candidates: ReadonlyArray<readonly [DropZone, number]> = [
    ["left", (point.x - rect.left) / rect.width],
    ["right", (rect.left + rect.width - point.x) / rect.width],
    ["top", (point.y - rect.top) / rect.height],
    ["bottom", (rect.top + rect.height - point.y) / rect.height],
  ];

  let best: DropZone = "center";
  let bestFraction = EDGE_BAND_FRACTION;
  for (const [zone, fraction] of candidates) {
    if (fraction < bestFraction) {
      best = zone;
      bestFraction = fraction;
    }
  }
  return best;
}
