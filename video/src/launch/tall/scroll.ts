import { easeInOutCubic, progress } from "../math.ts";
import { PANEL_ORDER, type PanelId, PANS } from "../wide/film90.ts";
import { TALL_H } from "./frame.ts";

/** Where scene `id`'s tall page starts on the long scroll, in px. */
export function panelY(id: PanelId): number {
  return PANEL_ORDER.indexOf(id) * TALL_H;
}

/** How far down the long scroll the camera is at film time `t`: the wide film's pans, turned downwards. */
export function scrollY(t: number): number {
  let from = 0;
  for (const pan of PANS) {
    const to = panelY(pan.to);
    if (t < pan.end) {
      const e = easeInOutCubic(progress(t, pan.start, pan.end - pan.start));
      return from + (to - from) * e;
    }
    from = to;
  }
  return from;
}
