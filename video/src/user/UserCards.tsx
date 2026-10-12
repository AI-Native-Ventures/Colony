import { AntMark } from "../brand/AntMark";
import { INTER } from "../launch/fonts";

const INK = "#17151f";
const MUTED = "#5d5a6e";

/** The Colony mark and name, as on the films' end cards. */
function Lockup({ size }: { size: number }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: size * 0.3,
        color: INK,
      }}
    >
      <span style={{ display: "flex", width: size * 1.5, height: size }}>
        <AntMark />
      </span>
      <span
        style={{
          fontSize: size,
          fontWeight: 800,
          letterSpacing: "-0.035em",
          lineHeight: 1,
        }}
      >
        Colony
      </span>
    </div>
  );
}

/** A full-frame card over the brand light: the lockup, a headline, a line under it. */
export const UserCard: React.FC<{
  opacity: number;
  headline: string;
  subline: string;
  /** A small last line, such as the address. */
  footer?: string;
}> = ({ opacity, headline, subline, footer }) =>
  opacity <= 0 ? null : (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 34,
        fontFamily: INTER,
        opacity,
        transform: `translateY(${((1 - opacity) * 18).toFixed(2)}px)`,
        paddingBottom: 120,
      }}
    >
      <Lockup size={58} />
      <div
        style={{
          fontSize: 104,
          fontWeight: 800,
          letterSpacing: "-0.04em",
          color: INK,
          lineHeight: 1.02,
          textAlign: "center",
        }}
      >
        {headline}
      </div>
      <div style={{ fontSize: 40, fontWeight: 500, color: MUTED }}>
        {subline}
      </div>
      {footer ? (
        <div
          style={{
            marginTop: 10,
            fontSize: 30,
            fontWeight: 700,
            color: INK,
            letterSpacing: "-0.01em",
          }}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
