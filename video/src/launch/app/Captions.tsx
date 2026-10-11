import { CAPTIONS } from "../film.ts";
import { INTER } from "../fonts";
import { easeOutExpo, progress, smoothstep } from "../math.ts";

const LINE_STYLE = [
  { top: 250, size: 76, weight: 800, color: "#ffffff", tracking: "-0.035em" },
  {
    top: 432,
    size: 40,
    weight: 600,
    color: "rgb(236 235 243 / 0.78)",
    tracking: "-0.01em",
  },
] as const;

/** Big words above the app window, arriving word by word and leaving softly. */
export const Captions: React.FC<{ t: number }> = ({ t }) => (
  <>
    {CAPTIONS.map((caption) => {
      if (t < caption.from || t > caption.to) return null;
      const out = 1 - smoothstep(caption.to - 0.3, caption.to, t);
      const style = LINE_STYLE[caption.line];
      // Each word keyed by where it starts in the line, so repeated words stay distinct.
      let offset = 0;
      const words = caption.text.split(" ").map((word, index) => {
        const at = offset;
        offset += word.length + 1;
        return { word, at, index };
      });
      return (
        <div
          key={caption.text}
          style={{
            position: "absolute",
            left: 110,
            width: 860,
            top: style.top,
            textAlign: "center",
            fontFamily: INTER,
            fontSize: style.size,
            fontWeight: style.weight,
            color: style.color,
            letterSpacing: style.tracking,
            lineHeight: 1.08,
            opacity: out,
            textWrap: "balance",
          }}
        >
          {words.map(({ word, at, index }) => {
            const e = easeOutExpo(
              progress(t, caption.from + index * 0.07, 0.5),
            );
            return (
              <span
                key={at}
                style={{
                  display: "inline-block",
                  marginRight: "0.24em",
                  opacity: e,
                  transform: `translateY(${((1 - e) * 26).toFixed(2)}px)`,
                  filter:
                    e < 1 ? `blur(${((1 - e) * 10).toFixed(2)}px)` : undefined,
                }}
              >
                {word}
              </span>
            );
          })}
        </div>
      );
    })}
  </>
);
