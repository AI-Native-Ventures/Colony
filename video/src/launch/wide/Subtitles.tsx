import { INTER } from "../fonts";
import { smoothstep } from "../math.ts";
import type { BeatLine } from "./beat.ts";
import { wordsShown } from "./karaoke.ts";

/**
 * The spoken line at the bottom, word by word as it is said, with key words
 * highlighted. Unspoken words keep their space so the line never shifts.
 */
export const Subtitles: React.FC<{
  t: number;
  lines: readonly BeatLine[];
  keywords: ReadonlySet<string>;
  holdLast?: boolean;
}> = ({ t, lines, keywords, holdLast = true }) => (
  <>
    {lines.map((line, index) => {
      const last = index === lines.length - 1;
      const until =
        last && holdLast ? Number.POSITIVE_INFINITY : line.speech[1] + 0.7;
      if (t < line.speech[0] - 0.05 || t > until) return null;
      const out = Number.isFinite(until)
        ? 1 - smoothstep(until - 0.25, until, t)
        : 1;
      const shown = wordsShown(line.text, line.speech, t);
      let offset = 0;
      const words = line.text.split(" ").map((word, i) => {
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
            color: "#17151f",
            opacity: out,
          }}
        >
          {words.map(({ word, at, i }) => {
            const hot = keywords.has(word);
            return (
              <span
                key={at}
                style={{
                  opacity: i < shown ? 1 : 0,
                  padding: hot ? "2px 10px" : undefined,
                  margin: hot ? "0 2px" : undefined,
                  borderRadius: 10,
                  background: hot ? "hsl(217 91% 60% / 0.16)" : undefined,
                  color: hot ? "hsl(217 80% 40%)" : undefined,
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
