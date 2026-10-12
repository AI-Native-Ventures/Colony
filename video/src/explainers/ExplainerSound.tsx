import { Audio, Sequence, staticFile, useVideoConfig } from "remotion";
import { musicVolume } from "../launch/duck.ts";
import { smoothstep } from "../launch/math.ts";
import type { ShellConfig } from "./ExplainerShell";

const DUCK = { base: 0.5, ducked: 0.18, attack: 0.25, release: 0.4 };

/**
 * Everything an explainer plays: music draft B ducked under the voice, the
 * sound effects and the voice lines. One piece, so the wide and the tall
 * explainers sound the same.
 */
export const ExplainerSound: React.FC<{ config: ShellConfig }> = ({
  config,
}) => {
  const { fps } = useVideoConfig();
  const { lines } = config;
  const windows = lines.map((l) => l.speech);
  return (
    <>
      {config.music.map((cue) => (
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
                musicVolume(s, windows, DUCK) *
                fadeIn *
                (1 - smoothstep(cue.until - 1.5, cue.until, s))
              );
            }}
          />
        </Sequence>
      ))}
      {config.whooshes.map((at) => (
        <Sequence
          key={`whoosh-${at}`}
          from={Math.round(at * fps)}
          layout="none"
        >
          <Audio src={staticFile("launch/sfx-whoosh.mp3")} volume={0.5} />
        </Sequence>
      ))}
      {config.pops.map((at) => (
        <Sequence key={`pop-${at}`} from={Math.round(at * fps)} layout="none">
          <Audio src={staticFile("launch/sfx-pop.mp3")} volume={0.45} />
        </Sequence>
      ))}
      {config.scribbles.map((s) => (
        <Sequence
          key={`scribble-${s.from}`}
          from={Math.round(s.from * fps)}
          durationInFrames={Math.round((s.until - s.from) * fps)}
          layout="none"
        >
          <Audio src={staticFile("launch/sfx-scribble.mp3")} volume={0.3} />
        </Sequence>
      ))}
      {config.clicks.map((at) => (
        <Sequence key={`click-${at}`} from={Math.round(at * fps)} layout="none">
          <Audio src={staticFile("launch/sfx-click.mp3")} volume={0.8} />
        </Sequence>
      ))}
      {(config.extras ?? []).map((x) => (
        <Sequence
          key={`extra-${x.file}-${x.at}`}
          from={Math.round(x.at * fps)}
          layout="none"
        >
          <Audio src={staticFile(x.file)} volume={x.volume} />
        </Sequence>
      ))}
      {lines.map((l) => (
        <Sequence key={l.id} from={Math.round(l.at * fps)} layout="none">
          <Audio src={staticFile(l.file)} />
        </Sequence>
      ))}
    </>
  );
};
