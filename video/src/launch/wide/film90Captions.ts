import type { Highlight } from "./Subtitles";
import { type EmployeeId, OWNER, TEAM, type Tone, TONES } from "./employees.ts";
import { ACT_PANEL, LINES, type PanelId } from "./film90.ts";

/** Lines whose words are already on screen as big type get no subtitle. */
export const CAPTION_OFF = new Set(["n04", "n06", "c01", "c02"]);
export const SHOWN_LINES = LINES.filter((line) => !CAPTION_OFF.has(line.id));
/** Lines said over the gradient world: key words in the brand violet. */
export const GRADIENT_ACTS = new Set(["weight", "colony", "close"]);
export const BRAND_HIGHLIGHT: Highlight = {
  bg: "hsl(258 90% 66% / 0.18)",
  fg: "hsl(258 70% 40%)",
};

export function toneOf(panel: PanelId): Tone {
  return (TEAM as readonly string[]).includes(panel)
    ? TONES[panel as EmployeeId]
    : OWNER;
}

export const KEYWORDS: Record<string, ReadonlySet<string>> = {
  n01: new Set(["love."]),
  n02: new Set(["everything", "else."]),
  n03: new Set(["never", "enough"]),
  n05: new Set(["app", "AI", "employees."]),
  n07: new Set(["Paste", "website.", "hires"]),
  s01: new Set(["Scout,", "chief", "staff."]),
  a01: new Set(["sells", "emails"]),
  a03: new Set(["office", "park", "on-call", "plumber."]),
  a04: new Set(["calls,", "meeting."]),
  l08: new Set(["finds", "customers."]),
  l09: new Set(["Twenty", "offices", "plumber,", "first", "coffee."]),
  l11: new Set(["posts.", "Three,", "Instagram."]),
  l12: new Set(["keeps", "website"]),
  l13: new Set(["first."]),
  l14: new Set(["yes."]),
  l15: new Set(["love,", "team", "moving."]),
};

export const HIGHLIGHTS: Record<string, Highlight> = Object.fromEntries(
  SHOWN_LINES.map((line) => {
    if (GRADIENT_ACTS.has(line.act)) return [line.id, BRAND_HIGHLIGHT];
    const tone = toneOf(ACT_PANEL[line.act] as PanelId);
    return [
      line.id,
      { bg: tone.color.replace(")", " / 0.16)"), fg: tone.deep },
    ];
  }),
);
