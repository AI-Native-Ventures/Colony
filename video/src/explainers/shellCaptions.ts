import type { Highlight } from "../launch/wide/Subtitles";
import type { Tone } from "../launch/wide/employees.ts";
import { captionUntil, type EpisodeLine } from "./episode.ts";

/** The hook's key words in Colony's violet. */
const BRAND: Highlight = {
  bg: "hsl(258 90% 66% / 0.18)",
  fg: "hsl(258 70% 40%)",
};

/**
 * An explainer's captions: the lines that get one, when each leaves, and
 * the colour its key words take (violet in the hook, the employee's after).
 */
export function shellCaptions(
  lines: readonly EpisodeLine[],
  tone: Tone,
): {
  shown: EpisodeLine[];
  until: Record<string, number>;
  highlights: Record<string, Highlight>;
} {
  const shown = lines.filter((l) => l.captioned);
  const until = Object.fromEntries(
    lines.map((l, i) => [l.id, captionUntil(lines, i)]),
  );
  const toneHighlight: Highlight = {
    bg: tone.color.replace(")", " / 0.16)"),
    fg: tone.deep,
  };
  const highlights = Object.fromEntries(
    shown.map((l) => [l.id, l.beat === "hook" ? BRAND : toneHighlight]),
  );
  return { shown, until, highlights };
}
