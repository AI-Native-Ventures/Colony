import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Grain } from "../Backdrop";
import { easeInOutCubic, progress } from "../math.ts";
import { useFontsReady } from "../useFontsReady";
import { CAMERA, cameraScale, WIDE_H, WIDE_W } from "./beat.ts";
import { BrightStage } from "./BrightStage";
import { CallCard } from "./CallCard";
import { CloseScene } from "./CloseScene";
import { CornerLogo } from "./CornerLogo";
import { DayPanel } from "./DayPanel";
import { EmailCard, PenAnt } from "./EmailCard";
import { EmployeeHero } from "./EmployeeHero";
import {
  GETTING_STARTED,
  LOOKS,
  OWNER,
  SCOUT_LOOK,
  TEAM,
} from "./employees.ts";
import {
  AMBER90,
  BLUE90,
  BLUE90_CAMERA,
  BURSTS90,
  CLOSE90,
  DAY90,
  GREEN90,
  PANEL_ORDER,
  type PanelId,
  PINK90,
  panelX,
  panX,
  RIVERS90,
  SCOUT90,
  YES90,
} from "./film90.ts";
import { BusinessCard, HowCursor } from "./HowPanel";
import { HOW } from "./how.ts";
import { InboxCard, InboxCarriers, InboxCursor } from "./InboxCard";
import { LightWorld } from "./MeshGradient";
import { INTRO } from "./intro.ts";
import { Carriers, LeadsBoard } from "./LeadsBoard";
import { PanelBlooms } from "./PanelBlooms";
import { PostCarriers, PostsGrid } from "./PostsGrid";
import { River } from "./River";
import { PlanCard } from "./ScoutPanel";
import { Subtitles } from "./Subtitles";
import { useWideAnts } from "./useWideAnts";
import { FilmSound } from "./FilmSound";
import { HIGHLIGHTS, KEYWORDS, SHOWN_LINES, toneOf } from "./film90Captions.ts";
import { Painter, WebsiteCard } from "./WebsiteCard";
import { WideOpening } from "./WideOpening";

/** Px per frame the camera is gliding at `t`, for a matching horizontal blur. */
function glideSpeed(t: number, fps: number): number {
  return Math.abs(panX(t + 0.5 / fps) - panX(t - 0.5 / fps));
}

const Panel: React.FC<{ id: PanelId; children: React.ReactNode }> = ({
  id,
  children,
}) => (
  <div
    style={{
      position: "absolute",
      left: panelX(id),
      top: 0,
      width: WIDE_W,
      height: WIDE_H,
    }}
  >
    <PanelBlooms tone={toneOf(id)} />
    {children}
  </div>
);

function panelContent(id: PanelId, t: number): React.ReactNode {
  if (id === "scout") {
    return (
      <>
        <EmployeeHero t={t} look={SCOUT_LOOK} timing={SCOUT90} />
        <PlanCard t={t} timing={SCOUT90} />
      </>
    );
  }
  if (id === "how") {
    return (
      <>
        <EmployeeHero t={t} look={GETTING_STARTED} timing={HOW} />
        <BusinessCard t={t} timing={HOW} />
        <HowCursor t={t} timing={HOW} />
      </>
    );
  }
  if (id === "yes") {
    return (
      <>
        <EmployeeHero t={t} look={OWNER} timing={YES90} />
        <InboxCard t={t} timing={YES90} />
        <InboxCarriers t={t} timing={YES90} />
        <InboxCursor t={t} timing={YES90} />
      </>
    );
  }
  if (id === "day") {
    return <DayPanel t={t} timing={DAY90} />;
  }
  if (id === "blue") {
    return (
      <>
        <EmployeeHero
          t={t}
          look={LOOKS.blue}
          timing={BLUE90}
          camera={BLUE90_CAMERA}
        />
        <LeadsBoard t={t} timing={BLUE90} />
        <Carriers t={t} timing={BLUE90} />
      </>
    );
  }
  if (id === "amber") {
    return (
      <>
        <EmployeeHero t={t} look={LOOKS.amber} timing={AMBER90} />
        <EmailCard t={t} timing={AMBER90} />
        <PenAnt t={t} timing={AMBER90} />
        <CallCard t={t} timing={AMBER90} />
      </>
    );
  }
  if (id === "pink") {
    return (
      <>
        <EmployeeHero t={t} look={LOOKS.pink} timing={PINK90} />
        <PostsGrid t={t} timing={PINK90} />
        <PostCarriers t={t} timing={PINK90} />
      </>
    );
  }
  return (
    <>
      <EmployeeHero t={t} look={LOOKS.green} timing={GREEN90} />
      <WebsiteCard t={t} timing={GREEN90} />
      <Painter t={t} timing={GREEN90} />
    </>
  );
}

/** The wide launch film: who it is for, what Colony is, how it works, the team, your yes, your day back. */
export const Film90: React.FC = () => {
  useFontsReady();
  const ants = useWideAnts();
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
  const zoom = cameraScale(t, BLUE90_CAMERA);
  const camX = panX(t);
  const blur = Math.min(36, glideSpeed(t, fps) * 0.32);
  const shown = PANEL_ORDER.filter(
    (id) => Math.abs(panelX(id) - camX) < WIDE_W,
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
          id="glide-blur"
          filterUnits="userSpaceOnUse"
          x={camX - 120}
          y={0}
          width={WIDE_W + 240}
          height={WIDE_H}
        >
          <feGaussianBlur stdDeviation={`${blur.toFixed(2)} 0`} />
        </filter>
      </svg>
      {reveal < 1 ? <LightWorld t={t} /> : null}
      <WideOpening t={t} ants={ants?.opening ?? null} />
      <AbsoluteFill
        style={{
          transform: `scale(${zoom.toFixed(5)})`,
          transformOrigin: `${CAMERA.focusX}px ${CAMERA.focusY}px`,
        }}
      >
        <BrightStage
          reveal={reveal}
          cx={WIDE_W / 2}
          cy={WIDE_H / 2}
          blooms={false}
          transition="fade"
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: WIDE_W * PANEL_ORDER.length,
              height: WIDE_H,
              transform: `translateX(${(-camX).toFixed(2)}px)`,
              filter: blur > 0.4 ? "url(#glide-blur)" : undefined,
            }}
          >
            {shown.map((id) => (
              <Panel key={id} id={id}>
                {panelContent(id, t)}
              </Panel>
            ))}
          </div>
        </BrightStage>
        {TEAM.map((id) => (
          <River key={id} t={t} spec={RIVERS90[id]} offsetX={camX} />
        ))}
        {BURSTS90.map((spec) => (
          <River key={spec.seed} t={t} spec={spec} offsetX={camX} />
        ))}
      </AbsoluteFill>
      <CloseScene t={t} timing={CLOSE90} ants={ants?.close ?? null} />
      <CornerLogo t={t} from={INTRO.brightTo} to={CLOSE90.dimFrom + 0.4} />
      <Subtitles
        t={t}
        lines={SHOWN_LINES}
        keywords={KEYWORDS}
        highlights={HIGHLIGHTS}
        holdLast={false}
      />
      <Grain t={t} width={WIDE_W} height={WIDE_H} opacity={0.05} />
      <FilmSound />
    </AbsoluteFill>
  );
};
