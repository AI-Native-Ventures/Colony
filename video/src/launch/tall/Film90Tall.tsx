import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Grain } from "../Backdrop";
import { easeInOutCubic, progress } from "../math.ts";
import { useFontsReady } from "../useFontsReady";
import { BrightStage } from "../wide/BrightStage";
import { GETTING_STARTED, SCOUT_LOOK } from "../wide/employees.ts";
import { FilmSound } from "../wide/FilmSound";
import { CLOSE90, PANEL_ORDER, type PanelId, SCOUT90 } from "../wide/film90.ts";
import {
  HIGHLIGHTS,
  KEYWORDS,
  SHOWN_LINES,
  toneOf,
} from "../wide/film90Captions.ts";
import { BusinessCard, HowCursor } from "../wide/HowPanel";
import { HOW } from "../wide/how.ts";
import { INTRO } from "../wide/intro.ts";
import { LightWorld } from "../wide/MeshGradient";
import { PanelBlooms } from "../wide/PanelBlooms";
import { PlanCard } from "../wide/ScoutPanel";
import { useOpeningAnts } from "../wide/useWideAnts";
import { WideOpening } from "../wide/WideOpening";
import { PANEL_TRANSFORM, TALL_H, TALL_W } from "./frame.ts";
import { TALL_OPENING } from "./opening.ts";
import { panelY, scrollY } from "./scroll.ts";
import { TallCaptions } from "./TallCaptions";
import { TallHero } from "./TallHero";

/** The film's cards for a scene, drawn in its panel pixels, placed into the tall card box. */
const Cards: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      position: "absolute",
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
      transform: PANEL_TRANSFORM,
      transformOrigin: "0 0",
    }}
  >
    {children}
  </div>
);

/** What one tall page shows: the employee on top, the film's own card below. */
function page(id: PanelId, t: number): React.ReactNode {
  if (id === "how") {
    return (
      <>
        <TallHero t={t} look={GETTING_STARTED} timing={HOW} />
        <Cards>
          <BusinessCard t={t} timing={HOW} />
          <HowCursor t={t} timing={HOW} />
        </Cards>
      </>
    );
  }
  if (id === "scout") {
    return (
      <>
        <TallHero t={t} look={SCOUT_LOOK} timing={SCOUT90} />
        <Cards>
          <PlanCard t={t} timing={SCOUT90} />
        </Cards>
      </>
    );
  }
  return null;
}

/** Px per frame the camera is scrolling at `t`, for a matching vertical blur. */
function scrollSpeed(t: number, fps: number): number {
  return Math.abs(scrollY(t + 0.5 / fps) - scrollY(t - 0.5 / fps));
}

/** The launch film for Reels: the same story and sound on a 1080 x 1920 frame. */
export const Film90Tall: React.FC = () => {
  useFontsReady();
  const ants = useOpeningAnts(TALL_OPENING);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const opened = easeInOutCubic(
    progress(t, INTRO.brightFrom, INTRO.brightTo - INTRO.brightFrom),
  );
  const closed = easeInOutCubic(
    progress(t, CLOSE90.dimFrom, CLOSE90.dark - CLOSE90.dimFrom),
  );
  const reveal = opened * (1 - closed);
  const camY = scrollY(t);
  const blur = Math.min(36, scrollSpeed(t, fps) * 0.32);
  const shown = PANEL_ORDER.filter(
    (id) => Math.abs(panelY(id) - camY) < TALL_H,
  );
  return (
    <AbsoluteFill style={{ backgroundColor: "#ece4f4" }}>
      <svg
        aria-hidden="true"
        width="0"
        height="0"
        style={{ position: "absolute" }}
      >
        <filter
          id="tall-glide-blur"
          filterUnits="userSpaceOnUse"
          x={0}
          y={camY - 120}
          width={TALL_W}
          height={TALL_H + 240}
        >
          <feGaussianBlur stdDeviation={`0 ${blur.toFixed(2)}`} />
        </filter>
      </svg>
      {reveal < 1 ? <LightWorld t={t} width={TALL_W} height={TALL_H} /> : null}
      <WideOpening t={t} ants={ants} layout={TALL_OPENING} />
      <BrightStage
        reveal={reveal}
        cx={TALL_W / 2}
        cy={TALL_H / 2}
        blooms={false}
        transition="fade"
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: TALL_W,
            height: TALL_H * PANEL_ORDER.length,
            transform: `translateY(${(-camY).toFixed(2)}px)`,
            filter: blur > 0.4 ? "url(#tall-glide-blur)" : undefined,
          }}
        >
          {shown.map((id) => (
            <div
              key={id}
              style={{
                position: "absolute",
                left: 0,
                top: panelY(id),
                width: TALL_W,
                height: TALL_H,
                overflow: "hidden",
              }}
            >
              <PanelBlooms tone={toneOf(id)} />
              {page(id, t)}
            </div>
          ))}
        </div>
      </BrightStage>
      <TallCaptions
        t={t}
        lines={SHOWN_LINES}
        keywords={KEYWORDS}
        highlights={HIGHLIGHTS}
      />
      <Grain t={t} width={TALL_W} height={TALL_H} opacity={0.05} />
      <FilmSound />
    </AbsoluteFill>
  );
};
