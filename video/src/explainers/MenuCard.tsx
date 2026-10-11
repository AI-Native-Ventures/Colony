import { INTER, SCRIPT, SERIF } from "../launch/fonts";
import { type Course, THANDI, WEDDING } from "./thandi.ts";

const IVORY = "#fbf8f1";
const GOLD = "#a8854a";
const SAGE = "#7d9a7a";
const INK = "#3d3a33";

/** A sprig of leaves, the card's one ornament. */
function Sprig({ width }: { width: number }) {
  const leaves = [
    { x: 20, y: 18, r: -35 },
    { x: 32, y: 12, r: -20 },
    { x: 46, y: 9, r: 0 },
    { x: 60, y: 12, r: 20 },
    { x: 72, y: 18, r: 35 },
  ];
  return (
    <svg
      aria-hidden="true"
      width={width}
      height={width * 0.32}
      viewBox="0 0 92 30"
    >
      <path d="M8 24 Q46 2 84 24" fill="none" stroke={SAGE} strokeWidth="1.4" />
      {leaves.map((l) => (
        <ellipse
          key={l.x}
          cx={l.x}
          cy={l.y}
          rx="6.5"
          ry="2.8"
          fill={SAGE}
          opacity="0.85"
          transform={`rotate(${l.r} ${l.x} ${l.y})`}
        />
      ))}
    </svg>
  );
}

/** The small leaf that marks a vegetarian dish. */
export function Leaf({ size }: { size: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24">
      <path
        d="M20 4C11 4 5 8.5 5 15.5c0 1.6.4 2.9 1 4C7.5 13 12 9.5 16 8c-3.6 2.2-7.2 6-8.8 12.3 1 .5 2.1.7 3.3.7C16.4 21 20 14.5 20 4Z"
        fill="#3f8f4f"
      />
    </svg>
  );
}

/** A wedding menu card in the Pinterest style: ivory, gold script, sage, the courses centred. */
export const MenuCard: React.FC<{
  w: number;
  h: number;
  courses: readonly Course[];
  /** A small line under the couple's names, for the vegetarian-friendly version. */
  tag?: string;
}> = ({ w, h, courses, tag }) => (
  <div
    style={{
      position: "relative",
      width: w,
      height: h,
      borderRadius: 10,
      background: IVORY,
      border: "1px solid #e6dfcc",
      boxShadow: "0 22px 40px -24px rgb(60 50 30 / 0.45)",
      boxSizing: "border-box",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      paddingTop: 14,
      color: INK,
      overflow: "hidden",
    }}
  >
    <Sprig width={92} />
    <div
      style={{
        fontFamily: SCRIPT,
        fontSize: 58,
        lineHeight: 1,
        color: GOLD,
        marginTop: -2,
      }}
    >
      Menu
    </div>
    <div
      style={{
        fontFamily: SERIF,
        fontSize: 15,
        letterSpacing: "0.22em",
        marginTop: 4,
      }}
    >
      {WEDDING.couple.toUpperCase()}
    </div>
    {tag ? (
      <div
        style={{
          marginTop: 8,
          height: 26,
          padding: "0 12px",
          borderRadius: 999,
          background: "#e6efe2",
          color: "#2f6f3d",
          fontFamily: INTER,
          fontSize: 14,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Leaf size={14} />
        {tag}
      </div>
    ) : null}
    <div
      style={{
        marginTop: tag ? 12 : 22,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 16,
      }}
    >
      {courses.map((c) => (
        <div key={c.course} style={{ textAlign: "center" }}>
          <div
            style={{
              fontFamily: INTER,
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: "0.24em",
              color: GOLD,
            }}
          >
            {c.course.toUpperCase()}
          </div>
          {c.dishes.map((d) => (
            <div
              key={d.name}
              style={{
                fontFamily: SERIF,
                fontSize: 19,
                fontWeight: 600,
                marginTop: 3,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
            >
              {d.name}
              {d.veg ? <Leaf size={17} /> : null}
            </div>
          ))}
        </div>
      ))}
    </div>
    <div
      style={{
        position: "absolute",
        bottom: 16,
        left: 40,
        right: 40,
        borderTop: "1px solid #e2d9c4",
        paddingTop: 8,
        textAlign: "center",
        fontFamily: SERIF,
        fontStyle: "italic",
        fontSize: 14,
        color: "#7a7263",
      }}
    >
      {THANDI.name}
    </div>
  </div>
);
