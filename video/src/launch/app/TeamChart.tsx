import { AntMark } from "../../brand/AntMark";
import { easeOutExpo, progress } from "../math.ts";
import { UI } from "./ui.ts";

type Employee = { job: string; color: string; at: number };

/** The four employees, in the same colors as their rivers of ants. */
const TEAM: Employee[] = [
  { job: "Finds customers", color: "hsl(217 91% 60%)", at: 13.7 },
  { job: "Emails new customers", color: "hsl(38 92% 50%)", at: 13.95 },
  { job: "Updates your website", color: "hsl(160 60% 45%)", at: 14.2 },
  { job: "Posts on Instagram", color: "hsl(330 81% 60%)", at: 14.45 },
];

const SLOTS = [
  { x: 56, y: 262 },
  { x: 484, y: 262 },
  { x: 56, y: 586 },
  { x: 484, y: 586 },
];

/** The real org chart card, filling with four working employees. */
export const TeamChart: React.FC<{ t: number; opacity: number }> = ({
  t,
  opacity,
}) => (
  <div style={{ position: "absolute", inset: 0, opacity }}>
    <div
      style={{
        position: "absolute",
        left: 56,
        top: 40,
        fontSize: 60,
        fontWeight: 700,
        letterSpacing: "-0.02em",
      }}
    >
      Org chart
    </div>
    <div
      style={{
        position: "absolute",
        right: 56,
        top: 52,
        padding: "14px 26px",
        borderRadius: 16,
        background: UI.violet,
        color: "#fff",
        fontSize: 24,
        fontWeight: 600,
      }}
    >
      Hire employee
    </div>
    <div
      style={{
        position: "absolute",
        left: 56,
        top: 120,
        width: 828,
        fontSize: 28,
        lineHeight: 1.35,
        color: UI.muted,
      }}
    >
      Who reports to whom, who is working, and what everyone may decide.
    </div>
    {TEAM.map((person, i) => {
      const e = easeOutExpo(progress(t, person.at, 0.5));
      if (e <= 0) return null;
      const pulse = progress(t, person.at, 0.9);
      return (
        <div
          key={person.job}
          style={{
            position: "absolute",
            left: SLOTS[i].x,
            top: SLOTS[i].y,
            width: 400,
            height: 300,
            borderRadius: 28,
            background: UI.card,
            border: `1.5px solid ${UI.line}`,
            boxShadow: `0 18px 40px -24px ${person.color}`,
            opacity: e,
            transform: `scale(${(0.88 + 0.12 * e).toFixed(4)}) translateY(${((1 - e) * 30).toFixed(2)}px)`,
            filter: e < 1 ? `blur(${((1 - e) * 8).toFixed(2)}px)` : undefined,
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 32,
              top: 32,
              width: 112,
              height: 112,
              borderRadius: "50%",
              background: person.color,
              boxShadow:
                pulse < 1
                  ? `0 0 0 ${(pulse * 22).toFixed(1)}px ${person.color.replace(")", ` / ${(0.35 * (1 - pulse)).toFixed(3)})`)}`
                  : undefined,
              display: "grid",
              placeItems: "center",
              color: "#fff",
            }}
          >
            <div style={{ width: 74, height: 49 }}>
              <AntMark />
            </div>
          </div>
          <div
            style={{
              position: "absolute",
              left: 32,
              top: 172,
              width: 340,
              fontSize: 33,
              fontWeight: 700,
              lineHeight: 1.15,
              letterSpacing: "-0.01em",
            }}
          >
            {person.job}
          </div>
          <div
            style={{
              position: "absolute",
              left: 32,
              top: 240,
              display: "flex",
              alignItems: "center",
              gap: 10,
              fontSize: 24,
              color: UI.muted,
            }}
          >
            <span
              style={{
                width: 14,
                height: 14,
                borderRadius: 7,
                background: "hsl(160 60% 45%)",
              }}
            />
            Working
          </div>
        </div>
      );
    })}
  </div>
);
