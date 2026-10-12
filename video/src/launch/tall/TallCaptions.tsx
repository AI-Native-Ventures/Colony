import { INTER } from "../fonts";
import { smoothstep } from "../math.ts";
import type { BeatLine } from "../wide/beat.ts";
import { wordsShown } from "../wide/karaoke.ts";
import type { Highlight } from "../wide/Subtitles";
import {
  type CaptionLook,
  captionChunks,
  chunkAt,
  FILM_CAPTIONS,
} from "./captions.ts";

const INK = "#17151f";
const BLUE_HIGHLIGHT: Highlight = {
  bg: "hsl(217 91% 60% / 0.16)",
  fg: "hsl(217 80% 40%)",
};
const NONE: ReadonlySet<string> = new Set();

/**
 * The spoken line, a chunk of two rows at a time: the chunk holding the word
 * being said, its words appearing as they are said and key words marked.
 * The line's last chunk stays until the line's caption leaves.
 */
export const TallCaptions: React.FC<{
  t: number;
  lines: readonly BeatLine[];
  keywords: Readonly<Record<string, ReadonlySet<string>>>;
  highlights?: Readonly<Record<string, Highlight>>;
  /** When each line's caption leaves, by id; default 0.7 s after its words. */
  until?: Readonly<Record<string, number>>;
  /** Type size, box and row length; the film's unless given. */
  look?: CaptionLook;
}> = ({
  t,
  lines,
  keywords,
  highlights,
  until: leaves,
  look = FILM_CAPTIONS,
}) => (
  <>
    {lines.map((line) => {
      const until = leaves?.[line.id] ?? line.speech[1] + 0.7;
      if (t < line.speech[0] - 0.05 || t > until) return null;
      const out = 1 - smoothstep(until - 0.25, until, t);
      const text = line.caption ?? line.text;
      const shown = wordsShown(text, line.speech, t);
      const chunks = captionChunks(text, look.rowChars);
      const chunk = chunks[chunkAt(chunks, shown)];
      const hot = keywords[line.id] ?? NONE;
      const tone = highlights?.[line.id] ?? BLUE_HIGHLIGHT;
      let index = chunk.from;
      return (
        <div
          key={line.id}
          style={{
            position: "absolute",
            left: look.box.x,
            top: look.box.y,
            width: look.box.w,
            textAlign: "center",
            fontFamily: INTER,
            fontSize: look.size,
            fontWeight: look.weight,
            lineHeight: 1.2,
            letterSpacing: "-0.01em",
            color: INK,
            opacity: out,
          }}
        >
          {chunk.rows.map((row) => (
            <div key={`${chunk.from}-${row}`} style={{ whiteSpace: "nowrap" }}>
              {row.split(" ").map((word) => {
                const i = index++;
                const isHot = hot.has(word);
                return (
                  <span
                    key={i}
                    style={{
                      opacity: i < shown ? 1 : 0,
                      padding: isHot
                        ? `${Math.round(look.size / 23)}px ${Math.round(look.size / 4.6)}px`
                        : undefined,
                      margin: isHot ? "0 2px" : undefined,
                      borderRadius: Math.round((look.size * 12) / 46),
                      background: isHot ? tone.bg : undefined,
                      color: isHot ? tone.fg : undefined,
                    }}
                  >
                    {word}{" "}
                  </span>
                );
              })}
            </div>
          ))}
        </div>
      );
    })}
  </>
);
