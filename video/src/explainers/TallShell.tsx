import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Grain } from "../launch/Backdrop";
import { easeInOutCubic, progress, smoothstep } from "../launch/math.ts";
import { TALL_CLOSE } from "../launch/tall/close.ts";
import { TALL_H, TALL_W } from "../launch/tall/frame.ts";
import { BIG_CAPTIONS } from "../launch/tall/captions.ts";
import { TallCaptions } from "../launch/tall/TallCaptions";
import { TallHero } from "../launch/tall/TallHero";
import { useFontsReady } from "../launch/useFontsReady";
import { BrightStage } from "../launch/wide/BrightStage";
import { CloseScene } from "../launch/wide/CloseScene";
import { LightWorld } from "../launch/wide/MeshGradient";
import { PanelBlooms } from "../launch/wide/PanelBlooms";
import { ExplainerSound } from "./ExplainerSound";
import type { ShellConfig } from "./ExplainerShell";
import { HookScene } from "./HookScene";
import { shellCaptions } from "./shellCaptions.ts";
import { TALL_HOOK } from "./tallHook.ts";

/**
 * An explainer on the Reels frame: the hook with its words on top, the
 * employee row that shrinks into a slim header at `compactAt` as the
 * episode's phone card comes in (children are frame pixels), the plain end
 * card above Instagram's caption, big captions a few words at a time, and
 * the same sound as the wide episode.
 */
export const TallShell: React.FC<{
  config: ShellConfig;
  /** When the employee row shrinks to the slim header, just before the card arrives. */
  compactAt: number;
  children: (t: number) => React.ReactNode;
}> = ({ config, compactAt, children }) => {
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
  const handOff = config.hero.until;
  return (
    <AbsoluteFill style={{ backgroundColor: "#f6eee4" }}>
      {reveal < 1 ? (
        <LightWorld t={t} stops={config.world} width={TALL_W} height={TALL_H} />
      ) : null}
      <HookScene t={t} hook={hook} layout={TALL_HOOK} />
      <BrightStage
        reveal={reveal}
        cx={TALL_W / 2}
        cy={TALL_H / 2}
        blooms={false}
        transition="fade"
      >
        <PanelBlooms tone={tone} />
        {handOff === undefined || t < handOff + 0.35 ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              opacity:
                handOff === undefined
                  ? 1
                  : 1 - smoothstep(handOff, handOff + 0.35, t),
            }}
          >
            <TallHero
              t={t}
              look={config.hero.look}
              timing={config.hero.timing}
              compactAt={compactAt}
            />
          </div>
        ) : null}
        {children(t)}
      </BrightStage>
      <CloseScene t={t} timing={close} ants={null} plain layout={TALL_CLOSE} />
      <TallCaptions
        t={t}
        lines={shown}
        keywords={config.keywords}
        highlights={highlights}
        until={until}
        look={BIG_CAPTIONS}
      />
      <Grain t={t} width={TALL_W} height={TALL_H} opacity={0.05} />
      <ExplainerSound config={config} />
    </AbsoluteFill>
  );
};
