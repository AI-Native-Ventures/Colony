import {
  AbsoluteFill,
  Audio,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Backdrop, Grain, Vignette } from "../Backdrop";
import { musicVolume } from "../duck.ts";
import { easeInOutCubic, progress, smoothstep } from "../math.ts";
import { useFontsReady } from "../useFontsReady";
import {
  AVATAR,
  CAMERA,
  cameraScale,
  LEADS,
  landsAt,
  WIDE_H,
  WIDE_W,
} from "./beat.ts";
import { BrightStage } from "./BrightStage";
import { DayPanel } from "./DayPanel";
import { chipShowsAt, TEAM_CHIPS } from "./day.ts";
import { EmailCard, PenAnt } from "./EmailCard";
import { EmployeeHero } from "./EmployeeHero";
import { emailTypedAt } from "./email.ts";
import {
  type EmployeeId,
  LOOKS,
  OWNER,
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
  YES90,
} from "./film90.ts";
import { InboxCard, InboxCarriers, InboxCursor } from "./InboxCard";
import { Carriers, LeadsBoard } from "./LeadsBoard";
import { PanelBlooms } from "./PanelBlooms";
import { PostCarriers, PostsGrid } from "./PostsGrid";
import { POSTS, postLandsAt } from "./posts.ts";
import { River } from "./River";
import { type Highlight, Subtitles } from "./Subtitles";
import { Painter, WebsiteCard } from "./WebsiteCard";
import { approvedAt, YES_ROWS, yesLandsAt } from "./yes.ts";

/**
 * Music draft B stands in until the 90 s track. It plays twice: from 25.4 s
 * so its lift lands on "20 found", and from 54.0 s so its lift lands on the
 * Approve click.
 */
const MUSIC_CUES = [25.4, 54.0];
const MUSIC_SECONDS = 30.04;
const DUCK = { base: 0.5, ducked: 0.18, attack: 0.25, release: 0.4 };
const WINDOWS = LINES.map((line) => line.speech);

/** Subtitles run for every line spoken in the bright world. */
const SHOWN_LINES = LINES.filter((line) => ACT_PANEL[line.act] !== undefined);

function toneOf(panel: PanelId): Tone {
  return (TEAM as readonly string[]).includes(panel)
    ? TONES[panel as EmployeeId]
    : OWNER;
}

const KEYWORDS: Record<string, ReadonlySet<string>> = {
  l08: new Set(["finds", "customers."]),
  l09: new Set(["Twenty", "offices", "plumber,", "first", "coffee."]),
  l10: new Set(["writes", "your", "words."]),
  l11: new Set(["posts.", "Three,", "Instagram."]),
  l12: new Set(["keeps", "website"]),
  l13: new Set(["first."]),
  l14: new Set(["yes."]),
  l15: new Set(["love,", "team", "moving."]),
};

const HIGHLIGHTS: Record<string, Highlight> = Object.fromEntries(
  SHOWN_LINES.map((line) => {
    const tone = toneOf(ACT_PANEL[line.act] as PanelId);
    return [
      line.id,
      { bg: tone.color.replace(")", " / 0.16)"), fg: tone.deep },
    ];
  }),
);

/** Sound cues: every landing pops, every glide whooshes. */
const POPS = [
  ...LEADS.map((_, i) => landsAt(i, BLUE90)),
  emailTypedAt(AMBER90) + 0.1,
  ...POSTS.map((_, i) => postLandsAt(i, PINK90)),
  PINK90.readyAt,
  GREEN90.chipAt,
  ...YES_ROWS.map((_, i) => yesLandsAt(i, YES90)),
  ...YES_ROWS.map((_, i) => approvedAt(i, YES90)),
  DAY90.summaryAt + 0.1,
];
/** The team's wins pop softly as the day runs. */
const SOFT_POPS = TEAM_CHIPS.map((chip) => chipShowsAt(chip, DAY90));
const WHOOSHES = [BLUE90.riverFrom, ...PANS.map((pan) => pan.start)];

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

/** The 90 second wide launch film. Built so far: meet the team, your yes, your day back. */
export const Film90: React.FC = () => {
  useFontsReady();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const reveal = easeInOutCubic(
    progress(t, BLUE90.brightFrom, BLUE90.brightTo - BLUE90.brightFrom),
  );
  const zoom = cameraScale(t, BLUE90_CAMERA);
  const camX = panX(t);
  const blur = Math.min(36, glideSpeed(t, fps) * 0.32);
  const shown = PANEL_ORDER.filter(
    (id) => Math.abs(panelX(id) - camX) < WIDE_W,
  );
  return (
    <AbsoluteFill style={{ backgroundColor: "#060509" }}>
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
      <Backdrop />
      <div style={{ position: "absolute", inset: 0, opacity: 1 - reveal }}>
        <Vignette />
      </div>
      <AbsoluteFill
        style={{
          transform: `scale(${zoom.toFixed(5)})`,
          transformOrigin: `${CAMERA.focusX}px ${CAMERA.focusY}px`,
        }}
      >
        <BrightStage reveal={reveal} cx={AVATAR.x} cy={AVATAR.y} blooms={false}>
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
      <div style={{ position: "absolute", inset: 0, opacity: reveal }}>
        <Subtitles
          t={t}
          lines={SHOWN_LINES}
          keywords={KEYWORDS}
          highlights={HIGHLIGHTS}
          holdLast={false}
        />
      </div>
      <Grain
        t={t}
        width={WIDE_W}
        height={WIDE_H}
        opacity={0.06 - 0.03 * reveal}
      />
      {MUSIC_CUES.map((from) => (
        <Sequence
          key={`music-${from}`}
          from={Math.round(from * fps)}
          layout="none"
        >
          <Audio
            src={staticFile("launch/music-b.mp3")}
            volume={(f) => {
              const s = from + f / fps;
              return (
                musicVolume(s, WINDOWS, DUCK) *
                (1 -
                  smoothstep(
                    from + MUSIC_SECONDS - 1.5,
                    from + MUSIC_SECONDS,
                    s,
                  ))
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
      <Sequence from={Math.round(YES90.click * fps)} layout="none">
        <Audio src={staticFile("launch/sfx-click.mp3")} volume={0.8} />
      </Sequence>
      <Sequence from={Math.round(approvedAt(0, YES90) * fps)} layout="none">
        <Audio src={staticFile("launch/sfx-whoosh.mp3")} volume={0.6} />
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
