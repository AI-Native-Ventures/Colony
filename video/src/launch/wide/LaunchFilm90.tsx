import {
  AbsoluteFill,
  Audio,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Grain } from "../Backdrop";
import { musicVolume } from "../duck.ts";
import { easeInOutCubic, progress, smoothstep } from "../math.ts";
import { useFontsReady } from "../useFontsReady";
import { CAMERA, cameraScale, LEADS, landsAt, WIDE_H, WIDE_W } from "./beat.ts";
import { BrightStage } from "./BrightStage";
import { CallCard } from "./CallCard";
import { CloseScene } from "./CloseScene";
import { CornerLogo } from "./CornerLogo";
import { DayPanel } from "./DayPanel";
import { chipShowsAt, TEAM_CHIPS } from "./day.ts";
import { EmailCard, PenAnt } from "./EmailCard";
import { EmployeeHero } from "./EmployeeHero";
import { emailTypedAt } from "./email.ts";
import {
  type EmployeeId,
  GETTING_STARTED,
  LOOKS,
  OWNER,
  SCOUT_LOOK,
  TEAM,
  type Tone,
  TONES,
} from "./employees.ts";
import {
  ACT_PANEL,
  AMBER90,
  BLUE90,
  BLUE90_CAMERA,
  BURSTS90,
  CLOSE90,
  DAY90,
  GREEN90,
  LINES,
  PANEL_ORDER,
  type PanelId,
  PANS,
  PINK90,
  panelX,
  panX,
  RIVERS90,
  SCOUT90,
  YES90,
} from "./film90.ts";
import { BusinessCard, HowCursor } from "./HowPanel";
import { HOW, TEAM_ROWS, teamRowAt } from "./how.ts";
import { InboxCard, InboxCarriers, InboxCursor } from "./InboxCard";
import { LightWorld } from "./MeshGradient";
import { INTRO } from "./intro.ts";
import { Carriers, LeadsBoard } from "./LeadsBoard";
import { PanelBlooms } from "./PanelBlooms";
import { PostCarriers, PostsGrid } from "./PostsGrid";
import { POSTS, postLandsAt } from "./posts.ts";
import { River } from "./River";
import { PlanCard } from "./ScoutPanel";
import { SCOUT_TASKS, taskLandsAt } from "./scout.ts";
import { type Highlight, Subtitles } from "./Subtitles";
import { useWideAnts } from "./useWideAnts";
import { Painter, WebsiteCard } from "./WebsiteCard";
import { WideOpening } from "./WideOpening";
import { approvedAt, YES_ROWS, yesLandsAt } from "./yes.ts";

/**
 * Music draft B stands in until a full-length track can be made. Four cuts of
 * it, each lifting at its 7 s mark on a big moment: the logo (17 s), Scout
 * handing out work (44.5 s), the posts (73.9 s) and the Approve click (89.9 s).
 * Each fades out as the next one starts.
 */
const MUSIC_CUES = [
  { from: 10.0, until: 40.0 },
  { from: 37.5, until: 67.5 },
  { from: 66.9, until: 84.4 },
  { from: 82.9, until: 112.9 },
];
const DUCK = { base: 0.5, ducked: 0.18, attack: 0.25, release: 0.4 };
const WINDOWS = LINES.map((line) => line.speech);

/** Lines whose words are already on screen as big type get no subtitle. */
const CAPTION_OFF = new Set(["n04", "n06", "c01", "c02"]);
const SHOWN_LINES = LINES.filter((line) => !CAPTION_OFF.has(line.id));
/** Lines said over the gradient world: key words in the brand violet. */
const GRADIENT_ACTS = new Set(["weight", "colony", "close"]);
const BRAND_HIGHLIGHT: Highlight = {
  bg: "hsl(258 90% 66% / 0.18)",
  fg: "hsl(258 70% 40%)",
};

function toneOf(panel: PanelId): Tone {
  return (TEAM as readonly string[]).includes(panel)
    ? TONES[panel as EmployeeId]
    : OWNER;
}

const KEYWORDS: Record<string, ReadonlySet<string>> = {
  n01: new Set(["love."]),
  n02: new Set(["everything", "else."]),
  n03: new Set(["never", "enough"]),
  n05: new Set(["app", "AI", "employees."]),
  n07: new Set(["Paste", "website.", "hires"]),
  s01: new Set(["Scout,", "chief", "staff."]),
  a01: new Set(["sells", "emails"]),
  a03: new Set(["office", "park", "on-call", "plumber."]),
  a04: new Set(["calls,", "meeting."]),
  l08: new Set(["finds", "customers."]),
  l09: new Set(["Twenty", "offices", "plumber,", "first", "coffee."]),
  l11: new Set(["posts.", "Three,", "Instagram."]),
  l12: new Set(["keeps", "website"]),
  l13: new Set(["first."]),
  l14: new Set(["yes."]),
  l15: new Set(["love,", "team", "moving."]),
};

const HIGHLIGHTS: Record<string, Highlight> = Object.fromEntries(
  SHOWN_LINES.map((line) => {
    if (GRADIENT_ACTS.has(line.act)) return [line.id, BRAND_HIGHLIGHT];
    const tone = toneOf(ACT_PANEL[line.act] as PanelId);
    return [
      line.id,
      { bg: tone.color.replace(")", " / 0.16)"), fg: tone.deep },
    ];
  }),
);

/** Sound cues: every landing pops, every glide whooshes. */
const POPS = [
  HOW.pasteAt,
  ...TEAM_ROWS.map((_, i) => teamRowAt(i, HOW)),
  ...SCOUT_TASKS.map((_, i) => taskLandsAt(i, SCOUT90)),
  AMBER90.bookedAt,
  ...LEADS.map((_, i) => landsAt(i, BLUE90)),
  emailTypedAt(AMBER90) + 0.1,
  ...POSTS.map((_, i) => postLandsAt(i, PINK90)),
  PINK90.readyAt,
  GREEN90.chipAt,
  ...YES_ROWS.map((_, i) => yesLandsAt(i, YES90)),
  ...YES_ROWS.map((_, i) => approvedAt(i, YES90)),
  DAY90.summaryAt + 0.1,
  CLOSE90.logoIn,
];
/** Soft presses on the owner's buttons. */
const PRESSES = [HOW.readClick, HOW.continueClick];
/** The team's wins pop softly as the day runs. */
const SOFT_POPS = TEAM_CHIPS.map((chip) => chipShowsAt(chip, DAY90));
const WHOOSHES = [
  INTRO.release,
  ...PANS.map((pan) => pan.start),
  CLOSE90.dimFrom,
];

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
      {MUSIC_CUES.map((cue) => (
        <Sequence
          key={`music-${cue.from}`}
          from={Math.round(cue.from * fps)}
          durationInFrames={Math.round((cue.until - cue.from) * fps)}
          layout="none"
        >
          <Audio
            src={staticFile("launch/music-b.mp3")}
            volume={(f) => {
              const s = cue.from + f / fps;
              return (
                musicVolume(s, WINDOWS, DUCK) *
                (1 - smoothstep(cue.until - 1.5, cue.until, s))
              );
            }}
          />
        </Sequence>
      ))}
      {WHOOSHES.map((at) => (
        <Sequence
          key={`whoosh-${at}`}
          from={Math.round(at * fps)}
          layout="none"
        >
          <Audio src={staticFile("launch/sfx-whoosh.mp3")} volume={0.5} />
        </Sequence>
      ))}
      {POPS.map((at) => (
        <Sequence key={`pop-${at}`} from={Math.round(at * fps)} layout="none">
          <Audio src={staticFile("launch/sfx-pop.mp3")} volume={0.45} />
        </Sequence>
      ))}
      <Sequence
        from={Math.round(AMBER90.typeFrom * fps)}
        durationInFrames={Math.round(
          (emailTypedAt(AMBER90) - AMBER90.typeFrom) * fps,
        )}
        layout="none"
      >
        <Audio src={staticFile("launch/sfx-scribble.mp3")} volume={0.3} />
      </Sequence>
      {SOFT_POPS.map((at) => (
        <Sequence key={`soft-${at}`} from={Math.round(at * fps)} layout="none">
          <Audio src={staticFile("launch/sfx-pop.mp3")} volume={0.28} />
        </Sequence>
      ))}
      {PRESSES.map((at) => (
        <Sequence key={`press-${at}`} from={Math.round(at * fps)} layout="none">
          <Audio src={staticFile("launch/sfx-click.mp3")} volume={0.45} />
        </Sequence>
      ))}
      <Sequence from={Math.round(YES90.click * fps)} layout="none">
        <Audio src={staticFile("launch/sfx-click.mp3")} volume={0.8} />
      </Sequence>
      <Sequence from={Math.round(approvedAt(0, YES90) * fps)} layout="none">
        <Audio src={staticFile("launch/sfx-whoosh.mp3")} volume={0.6} />
      </Sequence>
      <Sequence from={Math.round(AMBER90.callIn * fps)} layout="none">
        <Audio src={staticFile("launch/sfx-ring.mp3")} volume={0.35} />
      </Sequence>
      <Sequence from={Math.round(GREEN90.paintFrom * fps)} layout="none">
        <Audio src={staticFile("launch/sfx-shimmer.mp3")} volume={0.32} />
      </Sequence>
      {LINES.map((line) => (
        <Sequence key={line.id} from={Math.round(line.at * fps)} layout="none">
          <Audio src={staticFile(line.file)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
