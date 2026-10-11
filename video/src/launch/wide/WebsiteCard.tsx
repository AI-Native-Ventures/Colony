import { INTER } from "../fonts";
import {
  clamp01,
  easeOutExpo,
  lerpAngle,
  progress,
  smoothstep,
} from "../math.ts";
import { TONES } from "./employees.ts";
import { type Path, walkState } from "./walk.ts";
import { WorkerAnt } from "./WorkerAnt";

export type SiteTiming = {
  siteIn: number;
  paintFrom: number;
  paintDuration: number;
  chipAt: number;
};

const GREEN = TONES.green;
const INK = "#17151f";
const MUTED = "#6a6780";
const LINE = "#ece9f4";
const NAVY = "#13284a";
const AQUA = "hsl(190 85% 52%)";

/** The website card, in panel pixels; the page sits under a 64 px browser bar. */
export const SITE_CARD = { x: 860, y: 150, w: 940, h: 760 };
const BAR = 64;
const PAGE_H = SITE_CARD.h - BAR;
const PAINTER_SIZE = 64;
/** The painter walks along the bottom of the page, just inside it. */
const PAINT_Y = SITE_CARD.y + SITE_CARD.h - 44;

function tint(alpha: number): string {
  return GREEN.color.replace(")", ` / ${alpha})`);
}

/** The painter pushes the new page ahead of it, this far in front of its centre. */
const LEAD = 60;
const PAINT_START = SITE_CARD.x - LEAD;
const PAINT_END = SITE_CARD.x + SITE_CARD.w - LEAD;
const WALK_IN = 0.6;

/** A short walk in from the gap beside the card, clear of the subtitles. */
const WALK_IN_PATH: Path = [
  { x: PAINT_START - 110, y: PAINT_Y + 12 },
  { x: PAINT_START - 75, y: PAINT_Y + 6 },
  { x: PAINT_START - 35, y: PAINT_Y },
  { x: PAINT_START, y: PAINT_Y },
];

const PAINT_PATH: Path = [
  { x: PAINT_START, y: PAINT_Y },
  { x: PAINT_START + (PAINT_END - PAINT_START) / 3, y: PAINT_Y },
  { x: PAINT_START + (2 * (PAINT_END - PAINT_START)) / 3, y: PAINT_Y },
  { x: PAINT_END, y: PAINT_Y },
];

/** Walks up from below the frame, then across the bottom of the page; rests at the right as its owner. */
function painter(t: number, timing: SiteTiming) {
  if (t < timing.paintFrom) {
    const s = walkState(WALK_IN_PATH, t, timing.paintFrom - WALK_IN, WALK_IN);
    const settle = smoothstep(timing.paintFrom - 0.3, timing.paintFrom, t);
    return { ...s, angle: lerpAngle(s.angle, 0, settle) };
  }
  return walkState(PAINT_PATH, t, timing.paintFrom, timing.paintDuration);
}

/** How far the new page has been painted, 0 to 1 of the card width. */
function painted(t: number, timing: SiteTiming): number {
  if (t < timing.paintFrom) return 0;
  return clamp01((painter(t, timing).x + LEAD - SITE_CARD.x) / SITE_CARD.w);
}

/** The site as it was: grey, vague, last touched years ago. */
function OldPage() {
  return (
    <div style={{ position: "absolute", inset: 0, background: "#eceef1" }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: 64,
          background: "#dfe2e6",
          display: "flex",
          alignItems: "center",
          padding: "0 40px",
          gap: 30,
          fontSize: 20,
          color: "#9aa0aa",
        }}
      >
        <span
          style={{
            fontWeight: 700,
            letterSpacing: "0.12em",
            color: "#8a8f99",
          }}
        >
          BRIGHT PLUMBING
        </span>
        <span style={{ flex: 1 }} />
        <span>Home</span>
        <span>About</span>
        <span>Contact</span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 40,
          top: 130,
          width: 480,
          fontSize: 46,
          fontWeight: 700,
          lineHeight: 1.1,
          color: "#7a808a",
        }}
      >
        Welcome to our website!
      </div>
      <div
        style={{
          position: "absolute",
          left: 40,
          top: 260,
          width: 470,
          fontSize: 24,
          lineHeight: 1.45,
          color: "#9aa0aa",
        }}
      >
        We are a plumbing company. Call us for all your plumbing needs.
      </div>
      <div
        style={{
          position: "absolute",
          left: 40,
          top: 380,
          height: 54,
          padding: "0 26px",
          borderRadius: 6,
          background: "#c4c8cf",
          color: "#ffffff",
          fontSize: 22,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
        }}
      >
        Contact us
      </div>
      <div
        style={{
          position: "absolute",
          left: 570,
          top: 120,
          width: 320,
          height: 300,
          borderRadius: 6,
          background: "#d9dce1",
        }}
      >
        <svg
          aria-hidden="true"
          width="320"
          height="300"
          style={{ position: "absolute", inset: 0 }}
        >
          <path
            d="M0 0 L320 300 M320 0 L0 300"
            stroke="#c9cdd3"
            strokeWidth={3}
          />
        </svg>
      </div>
      <div
        style={{
          position: "absolute",
          left: 40,
          bottom: 86,
          fontSize: 20,
          color: "#a6abb3",
        }}
      >
        Last updated: March 2019
      </div>
    </div>
  );
}

/** The repainted site: clear offer, a real button, proof from customers. */
function NewPage() {
  return (
    <div style={{ position: "absolute", inset: 0, background: "#ffffff" }}>
      <div
        style={{
          position: "absolute",
          right: -160,
          top: -180,
          width: 640,
          height: 560,
          background:
            "radial-gradient(closest-side, hsl(190 85% 70% / 0.35), transparent)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: 72,
          display: "flex",
          alignItems: "center",
          padding: "0 40px",
          gap: 26,
          fontSize: 20,
          color: MUTED,
        }}
      >
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: 17,
            background: AQUA,
            display: "grid",
            placeItems: "center",
          }}
        >
          <svg aria-hidden="true" width="16" height="21" viewBox="0 0 40 52">
            <path
              d="M20 2 C20 2 4 22 4 33 a16 16 0 0 0 32 0 C36 22 20 2 20 2 Z"
              fill="#ffffff"
            />
          </svg>
        </span>
        <span style={{ fontWeight: 800, color: NAVY, fontSize: 22 }}>
          Bright Plumbing
        </span>
        <span style={{ flex: 1 }} />
        <span>Services</span>
        <span>Reviews</span>
        <span
          style={{
            height: 42,
            padding: "0 18px",
            borderRadius: 999,
            background: NAVY,
            color: "#ffffff",
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
          }}
        >
          Book now
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 40,
          top: 112,
          height: 38,
          padding: "0 16px",
          borderRadius: 999,
          background: "hsl(160 60% 45% / 0.12)",
          color: "hsl(160 64% 28%)",
          fontSize: 20,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
        }}
      >
        Open today until 18:00
      </div>
      <div
        style={{
          position: "absolute",
          left: 40,
          top: 172,
          fontSize: 56,
          fontWeight: 800,
          letterSpacing: "-0.035em",
          lineHeight: 1.04,
          color: NAVY,
        }}
      >
        Same-day plumber
        <br />
        in Sandton.
      </div>
      <div
        style={{
          position: "absolute",
          left: 40,
          top: 318,
          fontSize: 26,
          color: MUTED,
        }}
      >
        Leaks, drains and geysers, fixed fast.
      </div>
      <div
        style={{
          position: "absolute",
          left: 40,
          top: 384,
          display: "flex",
          alignItems: "center",
          gap: 22,
        }}
      >
        <span
          style={{
            height: 60,
            padding: "0 30px",
            borderRadius: 999,
            background: NAVY,
            color: "#ffffff",
            fontSize: 24,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
          }}
        >
          Book a visit
        </span>
        <span style={{ fontSize: 22, fontWeight: 600, color: INK }}>
          4.9 stars from 212 reviews
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 610,
          top: 110,
          width: 290,
          height: 330,
          borderRadius: 28,
          background: `linear-gradient(160deg, hsl(190 85% 60%), hsl(212 80% 48%))`,
          boxShadow: "0 30px 60px -30px hsl(212 80% 30% / 0.55)",
          display: "grid",
          placeItems: "center",
        }}
      >
        <svg aria-hidden="true" width="150" height="150" viewBox="0 0 24 24">
          <path
            d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3.6 17.4a1.6 1.6 0 1 0 2.3 2.3l5.7-5.7a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.1-.4-.4-2.1z"
            fill="#ffffff"
          />
        </svg>
      </div>
      <div
        style={{
          position: "absolute",
          left: 40,
          bottom: 86,
          fontSize: 20,
          fontWeight: 600,
          color: GREEN.deep,
        }}
      >
        Updated today
      </div>
    </div>
  );
}

/** The website card: the old page repainted by a green ant walking across it. */
export const WebsiteCard: React.FC<{ t: number; timing: SiteTiming }> = ({
  t,
  timing,
}) => {
  const enter = easeOutExpo(progress(t, timing.siteIn, 0.9));
  if (enter <= 0) return null;
  const wipe = painted(t, timing) * SITE_CARD.w;
  const edge =
    t >= timing.paintFrom && wipe < SITE_CARD.w
      ? 1 - smoothstep(SITE_CARD.w - 40, SITE_CARD.w, wipe)
      : 0;
  const chip = easeOutExpo(progress(t, timing.chipAt, 0.5));
  return (
    <div
      style={{
        position: "absolute",
        left: SITE_CARD.x,
        top: SITE_CARD.y,
        width: SITE_CARD.w,
        height: SITE_CARD.h,
        borderRadius: 28,
        background: "#ffffff",
        border: `1.5px solid ${LINE}`,
        boxShadow: "0 50px 100px -50px hsl(160 40% 25% / 0.45)",
        overflow: "hidden",
        fontFamily: INTER,
        color: INK,
        opacity: enter,
        transform: `translateX(${((1 - enter) * 90).toFixed(2)}px)`,
        filter:
          enter < 1 ? `blur(${((1 - enter) * 10).toFixed(2)}px)` : undefined,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          height: BAR,
          borderBottom: `1.5px solid ${LINE}`,
          display: "flex",
          alignItems: "center",
          padding: "0 24px",
          gap: 10,
        }}
      >
        {[0, 1, 2].map((k) => (
          <span
            key={k}
            style={{
              width: 14,
              height: 14,
              borderRadius: 7,
              background: "#e5e3ec",
            }}
          />
        ))}
        <span
          style={{
            marginLeft: 120,
            height: 40,
            width: 420,
            borderRadius: 999,
            background: "#f4f3f8",
            color: MUTED,
            fontSize: 21,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          brightplumbing.co.za
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            height: 40,
            padding: "0 16px",
            borderRadius: 999,
            background: tint(0.14),
            color: GREEN.deep,
            fontSize: 21,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            gap: 8,
            opacity: chip,
            transform: `scale(${(0.8 + 0.2 * chip).toFixed(4)})`,
          }}
        >
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24">
            <path
              d="M5 12.5l4.2 4.2L19 7"
              fill="none"
              stroke={GREEN.deep}
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Updated
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: BAR,
          height: PAGE_H,
          overflow: "hidden",
        }}
      >
        <OldPage />
        {wipe > 0 ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              clipPath: `inset(0 ${(SITE_CARD.w - wipe).toFixed(2)}px 0 0)`,
            }}
          >
            <NewPage />
          </div>
        ) : null}
        {edge > 0 ? (
          <div
            style={{
              position: "absolute",
              left: wipe - 2,
              top: 0,
              width: 4,
              height: PAGE_H,
              background: GREEN.color,
              opacity: edge,
              boxShadow: `0 0 28px 6px ${tint(0.45)}`,
            }}
          />
        ) : null}
      </div>
    </div>
  );
};

/** The green ant that walks across the page, repainting it as it goes. */
export const Painter: React.FC<{ t: number; timing: SiteTiming }> = ({
  t,
  timing,
}) => {
  if (t < timing.paintFrom - WALK_IN) return null;
  const s = painter(t, timing);
  return (
    <WorkerAnt
      x={s.x}
      y={s.y}
      angle={s.angle}
      size={PAINTER_SIZE}
      color={GREEN.color}
      phase={s.phase}
      amp={s.amp}
      opacity={smoothstep(
        timing.paintFrom - WALK_IN,
        timing.paintFrom - WALK_IN + 0.25,
        t,
      )}
    />
  );
};
