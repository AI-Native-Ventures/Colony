import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Grain } from "../Backdrop";
import { easeInOutCubic, progress } from "../math.ts";
import { useFontsReady } from "../useFontsReady";
import { BrightStage } from "../wide/BrightStage";
import { CallCard } from "../wide/CallCard";
import { CloseScene } from "../wide/CloseScene";
import { EmailCard, PenAnt } from "../wide/EmailCard";
import {
  GETTING_STARTED,
  LOOKS,
  OWNER,
  SCOUT_LOOK,
  TEAM,
} from "../wide/employees.ts";
import { FilmSound } from "../wide/FilmSound";
import {
  AMBER90,
  BLUE90,
  CLOSE90,
  DAY90,
  GREEN90,
  PANEL_ORDER,
  type PanelId,
  PINK90,
  SCOUT90,
  YES90,
} from "../wide/film90.ts";
import {
  HIGHLIGHTS,
  KEYWORDS,
  SHOWN_LINES,
  toneOf,
} from "../wide/film90Captions.ts";
import { BusinessCard, HowCursor } from "../wide/HowPanel";
import { HOW } from "../wide/how.ts";
import { InboxCard, InboxCarriers, InboxCursor } from "../wide/InboxCard";
import { INTRO } from "../wide/intro.ts";
import { Carriers, LeadsBoard } from "../wide/LeadsBoard";
import { LightWorld } from "../wide/MeshGradient";
import { PanelBlooms } from "../wide/PanelBlooms";
import { PostCarriers, PostsGrid } from "../wide/PostsGrid";
import { River } from "../wide/River";
import { PlanCard } from "../wide/ScoutPanel";
import { useCloseAnts, useOpeningAnts } from "../wide/useWideAnts";
import { Painter, WebsiteCard } from "../wide/WebsiteCard";
import { WideOpening } from "../wide/WideOpening";
import { tallCarryPath, tallYesCarryPath } from "./carriers.ts";
import { TALL_CLOSE, TALL_CLOSE_SWARM } from "./close.ts";
import { Cards } from "./Cards";
import { TALL_H, TALL_W } from "./frame.ts";
import { TALL_OPENING } from "./opening.ts";
import { TALL_BURSTS, TALL_RIVERS } from "./rivers.ts";
import { panelY, scrollY } from "./scroll.ts";
import { TallCaptions } from "./TallCaptions";
import { TallDay } from "./TallDay";
import { TallHero } from "./TallHero";

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
  if (id === "blue") {
    return (
      <>
        <TallHero t={t} look={LOOKS.blue} timing={BLUE90} />
        <Cards>
          <LeadsBoard t={t} timing={BLUE90} />
          <Carriers t={t} timing={BLUE90} path={tallCarryPath} />
        </Cards>
      </>
    );
  }
  if (id === "amber") {
    return (
      <>
        <TallHero t={t} look={LOOKS.amber} timing={AMBER90} />
        <Cards>
          <EmailCard t={t} timing={AMBER90} />
          <PenAnt t={t} timing={AMBER90} />
          <CallCard t={t} timing={AMBER90} />
        </Cards>
      </>
    );
  }
  if (id === "pink") {
    return (
      <>
        <TallHero t={t} look={LOOKS.pink} timing={PINK90} />
        <Cards>
          <PostsGrid t={t} timing={PINK90} />
          <PostCarriers t={t} timing={PINK90} />
        </Cards>
      </>
    );
  }
  if (id === "green") {
    return (
      <>
        <TallHero t={t} look={LOOKS.green} timing={GREEN90} />
        <Cards>
          <WebsiteCard t={t} timing={GREEN90} />
          <Painter t={t} timing={GREEN90} />
        </Cards>
      </>
    );
  }
  if (id === "yes") {
    return (
      <>
        <TallHero t={t} look={OWNER} timing={YES90} />
        <Cards>
          <InboxCard t={t} timing={YES90} />
          <InboxCarriers t={t} timing={YES90} path={tallYesCarryPath} />
          <InboxCursor t={t} timing={YES90} />
        </Cards>
      </>
    );
  }
  if (id === "day") {
    return <TallDay t={t} timing={DAY90} />;
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
  const closeAnts = useCloseAnts(TALL_CLOSE, TALL_CLOSE_SWARM);
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
      {TEAM.map((id) => (
        <River
          key={id}
          t={t}
          spec={TALL_RIVERS[id]}
          offsetY={camY}
          width={TALL_W}
          height={TALL_H}
        />
      ))}
      {TALL_BURSTS.map((spec) => (
        <River
          key={spec.seed}
          t={t}
          spec={spec}
          offsetY={camY}
          width={TALL_W}
          height={TALL_H}
        />
      ))}
      <CloseScene t={t} timing={CLOSE90} ants={closeAnts} layout={TALL_CLOSE} />
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
