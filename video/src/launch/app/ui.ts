import { smoothstep } from "../math.ts";
import type { Span } from "../film.ts";

/** Colors and sizes of the real desktop app (light theme), at film scale. */
export const UI = {
  page: "#f3f1f8",
  card: "#ffffff",
  line: "#e6e3ee",
  ink: "#1a1a2e",
  muted: "#6a6a7e",
  violet: "hsl(258 90% 66%)",
  violetSoft: "hsl(258 90% 66% / 0.12)",
  success: "hsl(160 60% 36%)",
  successSoft: "hsl(160 60% 45% / 0.14)",
};

/** Where the floating app window sits in the 1080 by 1920 frame. */
export const WINDOW = { left: 70, top: 560, width: 940, height: 1000 };
/** Height of the window's title bar; scene content is laid out below it. */
export const TITLE_BAR = 64;

/** 0 to 1 to 0 visibility for a scene inside the window, crossfading at its edges. */
export function sceneVisibility(t: number, span: Span, fade = 0.35): number {
  const inn = smoothstep(span.start - fade / 2, span.start + fade / 2, t);
  const out = 1 - smoothstep(span.end - fade / 2, span.end + fade / 2, t);
  return Math.min(inn, out);
}
