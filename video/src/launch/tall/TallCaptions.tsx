import { INTER } from "../fonts";
import { smoothstep } from "../math.ts";
import type { BeatLine } from "../wide/beat.ts";
import { wordsShown } from "../wide/karaoke.ts";
import type { Highlight } from "../wide/Subtitles";
import { captionChunks, chunkAt, ROW_CHARS } from "./captions.ts";
import { CAPTION_BOX } from "./frame.ts";

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
}> = ({ t, lines, keywords, highlights, until: leaves }) => (
  <>
    {lines.map((line) => {
      const until = leaves?.[line.id] ?? line.speech[1] + 0.7;
      if (t < line.speech[0] - 0.05 || t > until) return null;
      const out = 1 - smoothstep(until - 0.25, until, t);
      const text = line.caption ?? line.text;
      const shown = wordsShown(text, line.speech, t);
      const chunks = captionChunks(text, ROW_CHARS);
      const chunk = chunks[chunkAt(chunks, shown)];
      const hot = keywords[line.id] ?? NONE;
      const tone = highlights?.[line.id] ?? BLUE_HIGHLIGHT;
      let index = chunk.from;
      return (
        <div
          key={line.id}
          style={{
            position: "absolute",
            left: CAPTION_BOX.x,
            top: CAPTION_BOX.y,
            width: CAPTION_BOX.w,
            textAlign: "center",
            fontFamily: INTER,
            fontSize: 46,
            fontWeight: 700,
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
                      padding: isHot ? "2px 10px" : undefined,
                      margin: isHot ? "0 2px" : undefined,
                      borderRadius: 12,
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
