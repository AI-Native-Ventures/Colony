import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Grain } from "../launch/Backdrop";
import { easeInOutCubic, progress, smoothstep } from "../launch/math.ts";
import { useFontsReady } from "../launch/useFontsReady";
import { BrightStage } from "../launch/wide/BrightStage";
import { WIDE_H, WIDE_W } from "../launch/wide/beat.ts";
import { CloseScene } from "../launch/wide/CloseScene";
import { CornerLogo } from "../launch/wide/CornerLogo";
import { EmployeeHero, type HeroTiming } from "../launch/wide/EmployeeHero";
import type { HeroLook, Tone } from "../launch/wide/employees.ts";
import type { CLOSE90 } from "../launch/wide/film90.ts";
import { LightWorld } from "../launch/wide/MeshGradient";
import type { PaletteStop } from "../launch/wide/mesh.ts";
import { PanelBlooms } from "../launch/wide/PanelBlooms";
import { Subtitles } from "../launch/wide/Subtitles";
import type { EpisodeLine } from "./episode.ts";
import { ExplainerSound } from "./ExplainerSound";
import { type HookConfig, HookScene } from "./HookScene";
import { shellCaptions } from "./shellCaptions.ts";

/** Everything one explainer needs beyond its work scene. */
export type ShellConfig = {
  lines: EpisodeLine[];
  keywords: Readonly<Record<string, ReadonlySet<string>>>;
  tone: Tone;
  world: PaletteStop[];
  hook: HookConfig;
  /** The episode's employee; `until` hands the stage to another employee, fading this one out. */
  hero: { look: HeroLook; timing: HeroTiming; until?: number };
  /** The end card, in the launch film's close keys; `dimFrom` to `dark` closes the stage. */
  close: typeof CLOSE90;
  /** Music draft B cues: film seconds, and where in the track each starts. */
  music: readonly { from: number; until: number; trackAt: number }[];
  pops: readonly number[];
  whooshes: readonly number[];
  clicks: readonly number[];
  scribbles: readonly { from: number; until: number }[];
  extras?: readonly { at: number; file: string; volume: number }[];
};

/**
 * The world every explainer lives in: the hook on the light gradient, the
 * bright stage with the employee and the work, the plain end card, captions
 * that hold until the next line, the voice, music and sound effects.
 */
export const ExplainerShell: React.FC<{
  config: ShellConfig;
  children: (t: number) => React.ReactNode;
}> = ({ config, children }) => {
  useFontsReady();
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const { hook, close, lines, tone } = config;
  const opened = easeInOutCubic(
    progress(t, hook.stageFrom, hook.stageTo - hook.stageFrom),
  );
  const closed = easeInOutCubic(
    progress(t, close.dimFrom, close.dark - close.dimFrom),
  );
  const reveal = opened * (1 - closed);
  const { shown, until, highlights } = shellCaptions(lines, tone);
  return (
    <AbsoluteFill style={{ backgroundColor: "#f6eee4" }}>
      {reveal < 1 ? <LightWorld t={t} stops={config.world} /> : null}
      <HookScene t={t} hook={hook} />
      <BrightStage
        reveal={reveal}
        cx={WIDE_W / 2}
        cy={WIDE_H / 2}
        blooms={false}
        transition="fade"
      >
        <PanelBlooms tone={tone} />
        {config.hero.until === undefined ? (
          <EmployeeHero
            t={t}
            look={config.hero.look}
            timing={config.hero.timing}
          />
        ) : t < config.hero.until + 0.35 ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              opacity:
                1 - smoothstep(config.hero.until, config.hero.until + 0.35, t),
            }}
          >
            <EmployeeHero
              t={t}
              look={config.hero.look}
              timing={config.hero.timing}
            />
          </div>
        ) : null}
        {children(t)}
      </BrightStage>
      <CloseScene t={t} timing={close} ants={null} plain />
      <CornerLogo t={t} from={hook.stageTo} to={close.dimFrom + 0.4} />
      <Subtitles
        t={t}
        lines={shown}
        keywords={config.keywords}
        highlights={highlights}
        holdLast={false}
        until={until}
      />
      <Grain t={t} width={WIDE_W} height={WIDE_H} opacity={0.05} />
      <ExplainerSound config={config} />
    </AbsoluteFill>
  );
};
