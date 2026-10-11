import { INTER } from "../fonts";
import {
  clamp01,
  easeOutExpo,
  lerpAngle,
  progress,
  smoothstep,
} from "../math.ts";
import { BRIGHT, PAGE_H, PAINT_Y, SITE_BAR, SITE_CARD } from "./bright.ts";
import { NewPage, OldPage } from "./BrightSite";
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

const BAR = SITE_BAR;
const PAINTER_SIZE = 64;

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

const FILM_PAGES = { Old: OldPage, New: NewPage };

/** The website card: the old page repainted by a green ant walking across it. */
export const WebsiteCard: React.FC<{
  t: number;
  timing: SiteTiming;
  /** Defaults are the launch film's Bright Plumbing pages and address. */
  pages?: { Old: React.FC; New: React.FC };
  domain?: string;
  domainWidth?: number;
  /** Takes the place of the Updated chip at the right of the browser bar. */
  barEnd?: React.ReactNode;
  /** The old page shows again in this window: the owner looking at before. */
  before?: { from: number; until: number };
}> = ({
  t,
  timing,
  pages = FILM_PAGES,
  domain = BRIGHT.domain,
  domainWidth = 420,
  barEnd,
  before,
}) => {
  const enter = easeOutExpo(progress(t, timing.siteIn, 0.9));
  if (enter <= 0) return null;
  const wipe = painted(t, timing) * SITE_CARD.w;
  const edge =
    t >= timing.paintFrom && wipe < SITE_CARD.w
      ? 1 - smoothstep(SITE_CARD.w - 40, SITE_CARD.w, wipe)
      : 0;
  const chip = easeOutExpo(progress(t, timing.chipAt, 0.5));
  const shown = before
    ? 1 -
      smoothstep(before.from, before.from + 0.2, t) +
      smoothstep(before.until, before.until + 0.2, t)
    : 1;
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
            width: domainWidth,
            borderRadius: 999,
            background: "#f4f3f8",
            color: MUTED,
            fontSize: 21,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {domain}
        </span>
        <span style={{ flex: 1 }} />
        {barEnd !== undefined ? (
          barEnd
        ) : (
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
        )}
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
        <pages.Old />
        {wipe > 0 && shown > 0 ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              clipPath: `inset(0 ${(SITE_CARD.w - wipe).toFixed(2)}px 0 0)`,
              opacity: shown < 1 ? shown : undefined,
            }}
          >
            <pages.New />
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
