import {
  AbsoluteFill,
  Audio,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Grain } from "../launch/Backdrop";
import { musicVolume } from "../launch/duck.ts";
import { easeInOutCubic, progress, smoothstep } from "../launch/math.ts";
import { useFontsReady } from "../launch/useFontsReady";
import { BrightStage } from "../launch/wide/BrightStage";
import { WIDE_H, WIDE_W } from "../launch/wide/beat.ts";
import { CloseScene } from "../launch/wide/CloseScene";
import { CornerLogo } from "../launch/wide/CornerLogo";
import { EmployeeHero } from "../launch/wide/EmployeeHero";
import { LOOKS, TONES } from "../launch/wide/employees.ts";
import { LightWorld } from "../launch/wide/MeshGradient";
import type { PaletteStop } from "../launch/wide/mesh.ts";
import { PanelBlooms } from "../launch/wide/PanelBlooms";
import { postLandsAt } from "../launch/wide/posts.ts";
import { type Highlight, Subtitles } from "../launch/wide/Subtitles";
import { EP05, EP05_LINES, EP05_REQUEST } from "./ep05.ts";
import { captionUntil } from "./episode.ts";
import { HookScene } from "./HookScene";
import { RISE_POSTS } from "./rise.ts";
import {
  ApproveCursor,
  RisePostCarriers,
  RisePostsCard,
} from "./RisePostsCard";

/** Warm for the bakery's hook, back to Colony's lilac for the end card. */
const WORLD: PaletteStop[] = [
  { id: "sunset", at: 0 },
  { id: "lilac", at: EP05.closeFrom },
];

const PINK = TONES.pink;
const SHOWN = EP05_LINES.filter((l) => l.captioned);
const UNTIL: Record<string, number> = Object.fromEntries(
  EP05_LINES.map((l, i) => [l.id, captionUntil(EP05_LINES, i)]),
);
const BRAND: Highlight = {
  bg: "hsl(258 90% 66% / 0.18)",
  fg: "hsl(258 70% 40%)",
};
const PINK_HIGHLIGHT: Highlight = {
  bg: PINK.color.replace(")", " / 0.16)"),
  fg: PINK.deep,
};
const HIGHLIGHTS: Record<string, Highlight> = Object.fromEntries(
  SHOWN.map((l) => [l.id, l.beat === "hook" ? BRAND : PINK_HIGHLIGHT]),
);
const KEYWORDS: Record<string, ReadonlySet<string>> = {
  h1: new Set(["post?", "honest."]),
  m1: new Set(["AI", "employees.", "posts."]),
  w1: new Set(["sourdough,", "Saturday", "market."]),
  w2: new Set(["words", "pictures,", "style."]),
  w3: new Set(["best", "times"]),
  y1: new Set(["yes."]),
};

/** The end card, in the launch film's close keys. */
const CLOSE = {
  dimFrom: EP05.closeFrom,
  dark: EP05.closeDark,
  logoIn: EP05.logoIn,
  name: EP05.name,
  tagline: EP05.tagline,
  earlyAt: EP05.earlyAt,
  urlAt: EP05.urlAt,
};

/**
 * Music draft B stands in, as in the launch film: its lift (7 s into the
 * track) lands on the stage opening, then again on the end card's logo.
 */
const MUSIC_LIFT = 7;
const MUSIC_CUES = [
  { from: 0, until: 24, trackAt: MUSIC_LIFT - EP05.stageTo },
  {
    from: 22.5,
    until: 33,
    trackAt: MUSIC_LIFT - (EP05.logoIn - 22.5),
  },
];
const DUCK = { base: 0.5, ducked: 0.18, attack: 0.25, release: 0.4 };
const WINDOWS = EP05_LINES.map((l) => l.speech);

const POPS = [
  ...RISE_POSTS.map((_, i) => postLandsAt(i, EP05)),
  EP05.readyAt,
  EP05.scheduledAt,
  EP05.logoIn,
];
const WHOOSHES = [EP05.stageFrom, EP05.closeFrom];
const TYPED_BY = EP05.requestFrom + EP05_REQUEST.length / EP05.requestCps;

/** Explainer 5, "Makes your posts", for Rise Bakery. */
export const Explainer05: React.FC = () => {
  useFontsReady();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const opened = easeInOutCubic(
    progress(t, EP05.stageFrom, EP05.stageTo - EP05.stageFrom),
  );
  const closed = easeInOutCubic(
    progress(t, EP05.closeFrom, EP05.closeDark - EP05.closeFrom),
  );
  const reveal = opened * (1 - closed);
  return (
    <AbsoluteFill style={{ backgroundColor: "#f6eee4" }}>
      {reveal < 1 ? <LightWorld t={t} stops={WORLD} /> : null}
      <HookScene t={t} />
      <BrightStage
        reveal={reveal}
        cx={WIDE_W / 2}
        cy={WIDE_H / 2}
        blooms={false}
        transition="fade"
      >
        <PanelBlooms tone={PINK} />
        <EmployeeHero t={t} look={LOOKS.pink} timing={EP05} />
        <RisePostsCard t={t} />
        <RisePostCarriers t={t} />
        <ApproveCursor t={t} />
      </BrightStage>
      <CloseScene t={t} timing={CLOSE} ants={null} plain />
      <CornerLogo t={t} from={EP05.stageTo} to={EP05.closeFrom + 0.4} />
      <Subtitles
        t={t}
        lines={SHOWN}
        keywords={KEYWORDS}
        highlights={HIGHLIGHTS}
        holdLast={false}
        until={UNTIL}
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
            trimBefore={Math.round(cue.trackAt * fps)}
            volume={(f) => {
              const s = cue.from + f / fps;
              const fadeIn =
                cue.from > 0 ? smoothstep(cue.from, cue.from + 1.5, s) : 1;
              return (
                musicVolume(s, WINDOWS, DUCK) *
                fadeIn *
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
        from={Math.round(EP05.requestFrom * fps)}
        durationInFrames={Math.round((TYPED_BY - EP05.requestFrom) * fps)}
        layout="none"
      >
        <Audio src={staticFile("launch/sfx-scribble.mp3")} volume={0.3} />
      </Sequence>
      <Sequence from={Math.round(EP05.click * fps)} layout="none">
        <Audio src={staticFile("launch/sfx-click.mp3")} volume={0.8} />
      </Sequence>
      <Sequence from={Math.round(EP05.swarmBuilt * fps)} layout="none">
        <Audio src={staticFile("launch/sfx-shimmer.mp3")} volume={0.25} />
      </Sequence>
      {EP05_LINES.map((l) => (
        <Sequence key={l.id} from={Math.round(l.at * fps)} layout="none">
          <Audio src={staticFile(l.file)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
