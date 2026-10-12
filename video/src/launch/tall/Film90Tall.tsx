import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Grain } from "../Backdrop";
import { easeInOutCubic, progress } from "../math.ts";
import { useFontsReady } from "../useFontsReady";
import { BrightStage } from "../wide/BrightStage";
import { CloseScene } from "../wide/CloseScene";
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
import { FACTS, HOW, WEBSITE } from "../wide/how.ts";
import { INTRO } from "../wide/intro.ts";
import { LightWorld } from "../wide/MeshGradient";
import { PanelBlooms } from "../wide/PanelBlooms";
import { River } from "../wide/River";
import { useCloseAnts, useOpeningAnts } from "../wide/useWideAnts";
import { WideOpening } from "../wide/WideOpening";
import { LeadsOnlyPhone } from "../../explainers/LeadsPhone";
import { PlanPhone } from "../../explainers/PlanPhone";
import { SalesPhone } from "../../explainers/SalesPhone";
import { SiteUpdatePhone } from "../../explainers/SitePhone";
import { ReadCursor, TeamPhone } from "../../explainers/TeamPhone";
import { BRIGHT_SITE } from "./BrightPhonePages";
import { TALL_CLOSE, TALL_CLOSE_SWARM } from "./close.ts";
import {
  FILM_COMPACT_AT,
  FILM_LEADS,
  FILM_PLAN,
  FILM_SALES,
} from "./filmPages.ts";
import { TALL_H, TALL_W } from "./frame.ts";
import { InboxPhone, InboxPhoneCursor } from "./InboxPhone";
import { TALL_OPENING } from "./opening.ts";
import { PostsPhone } from "./PostsPhone";
import { TALL_BURSTS, TALL_RIVERS } from "./rivers.ts";
import { panelY, scrollY } from "./scroll.ts";
import { BIG_CAPTIONS } from "./captions.ts";
import { TallCaptions } from "./TallCaptions";
import { TallDay } from "./TallDay";
import { TallHero } from "./TallHero";

/** What one tall page shows: the employee on top, the film's own card below. */
function page(id: PanelId, t: number): React.ReactNode {
  if (id === "how") {
    return (
      <>
        <TallHero
          t={t}
          look={GETTING_STARTED}
          timing={HOW}
          compactAt={FILM_COMPACT_AT.how}
        />
        <TeamPhone
          t={t}
          timing={HOW}
          business={{ website: WEBSITE, facts: FACTS }}
        />
        <ReadCursor t={t} timing={HOW} />
      </>
    );
  }
  if (id === "scout") {
    return (
      <>
        <TallHero
          t={t}
          look={SCOUT_LOOK}
          timing={SCOUT90}
          compactAt={FILM_COMPACT_AT.scout}
        />
        <PlanPhone t={t} timing={SCOUT90} plan={FILM_PLAN} />
      </>
    );
  }
  if (id === "blue") {
    return (
      <>
        <TallHero
          t={t}
          look={LOOKS.blue}
          timing={BLUE90}
          compactAt={FILM_COMPACT_AT.blue}
        />
        <LeadsOnlyPhone t={t} timing={BLUE90} setup={FILM_LEADS} />
      </>
    );
  }
  if (id === "amber") {
    return (
      <>
        <TallHero
          t={t}
          look={LOOKS.amber}
          timing={AMBER90}
          compactAt={FILM_COMPACT_AT.amber}
        />
        <SalesPhone t={t} timing={AMBER90} setup={FILM_SALES} />
      </>
    );
  }
  if (id === "pink") {
    return (
      <>
        <TallHero
          t={t}
          look={LOOKS.pink}
          timing={PINK90}
          compactAt={FILM_COMPACT_AT.pink}
        />
        <PostsPhone t={t} timing={PINK90} />
      </>
    );
  }
  if (id === "green") {
    return (
      <>
        <TallHero
          t={t}
          look={LOOKS.green}
          timing={GREEN90}
          compactAt={FILM_COMPACT_AT.green}
        />
        <SiteUpdatePhone t={t} timing={GREEN90} site={BRIGHT_SITE} />
      </>
    );
  }
  if (id === "yes") {
    return (
      <>
        <TallHero
          t={t}
          look={OWNER}
          timing={YES90}
          compactAt={FILM_COMPACT_AT.yes}
        />
        <InboxPhone t={t} timing={YES90} />
        <InboxPhoneCursor t={t} timing={YES90} />
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
        look={BIG_CAPTIONS}
      />
      <Grain t={t} width={TALL_W} height={TALL_H} opacity={0.05} />
      <FilmSound />
    </AbsoluteFill>
  );
};
