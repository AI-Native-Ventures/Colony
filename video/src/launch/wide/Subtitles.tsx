import { INTER } from "../fonts";
import { smoothstep } from "../math.ts";
import type { BeatLine } from "./beat.ts";
import { wordsShown } from "./karaoke.ts";

export type Highlight = { bg: string; fg: string };

const BLUE_HIGHLIGHT: Highlight = {
  bg: "hsl(217 91% 60% / 0.16)",
  fg: "hsl(217 80% 40%)",
};
const NONE: ReadonlySet<string> = new Set();

type Keywords =
  | ReadonlySet<string>
  | Readonly<Record<string, ReadonlySet<string>>>;

function isOneSet(k: Keywords): k is ReadonlySet<string> {
  return k instanceof Set;
}

/**
 * The spoken line at the bottom, word by word as it is said, with key words
 * highlighted. Unspoken words keep their space so the line never shifts.
 * `keywords` is one set for every line, or a set per line id; `highlights`
 * colors a line's key words (blue by default).
 */
export const Subtitles: React.FC<{
  t: number;
  lines: readonly BeatLine[];
  keywords: Keywords;
  highlights?: Readonly<Record<string, Highlight>>;
  /** Text color per line id, for lines over the dark world. */
  inks?: Readonly<Record<string, string>>;
  holdLast?: boolean;
  /** When each line's caption leaves, by id; default 0.7 s after its words. */
  until?: Readonly<Record<string, number>>;
}> = ({
  t,
  lines,
  keywords,
  highlights,
  inks,
  holdLast = true,
  until: leaves,
}) => (
  <>
    {lines.map((line, index) => {
      const last = index === lines.length - 1;
      const until =
        last && holdLast
          ? Number.POSITIVE_INFINITY
          : (leaves?.[line.id] ?? line.speech[1] + 0.7);
      if (t < line.speech[0] - 0.05 || t > until) return null;
      const out = Number.isFinite(until)
        ? 1 - smoothstep(until - 0.25, until, t)
        : 1;
      const text = line.caption ?? line.text;
      const shown = wordsShown(text, line.speech, t);
      const hotWords = isOneSet(keywords)
        ? keywords
        : (keywords[line.id] ?? NONE);
      const tone = highlights?.[line.id] ?? BLUE_HIGHLIGHT;
      let offset = 0;
      const words = text.split(" ").map((word, i) => {
        const at = offset;
        offset += word.length + 1;
        return { word, at, i };
      });
      return (
        <div
          key={line.id}
          style={{
            position: "absolute",
            left: 160,
            right: 160,
            top: 968,
            textAlign: "center",
            fontFamily: INTER,
            fontSize: 36,
            fontWeight: 600,
            color: inks?.[line.id] ?? "#17151f",
            opacity: out,
          }}
        >
          {words.map(({ word, at, i }) => {
            const hot = hotWords.has(word);
            return (
              <span
                key={at}
                style={{
                  opacity: i < shown ? 1 : 0,
                  padding: hot ? "2px 10px" : undefined,
                  margin: hot ? "0 2px" : undefined,
                  borderRadius: 10,
                  background: hot ? tone.bg : undefined,
                  color: hot ? tone.fg : undefined,
                }}
              >
                {word}{" "}
              </span>
            );
          })}
        </div>
      );
    })}
  </>
);
