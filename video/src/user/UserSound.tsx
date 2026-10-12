import { Audio, Sequence, staticFile, useVideoConfig } from "remotion";
import { musicVolume } from "../launch/duck.ts";
import { smoothstep } from "../launch/math.ts";

/** Quieter than the explainers: in a walkthrough the voice carries everything. */
const DUCK = { base: 0.28, ducked: 0.09, attack: 0.25, release: 0.4 };

/** Music draft B's 30 s, then its groove from 7 s, looped with 1.5 s crossfades. */
function musicCues(seconds: number) {
  const cues = [{ from: 0, until: Math.min(30, seconds), trackAt: 0 }];
  for (let from = 28.5; from < seconds - 2; from += 21.5)
    cues.push({ from, until: Math.min(from + 23, seconds), trackAt: 7 });
  return cues;
}

export type SoundLine = {
  id: string;
  file: string;
  at: number;
  speech: readonly [number, number];
};

/** A user video's sound: its voice lines, a click on each click, music ducked under the voice. */
export const UserSound: React.FC<{
  lines: readonly SoundLine[];
  clicks: readonly number[];
  seconds: number;
}> = ({ lines, clicks, seconds }) => {
  const { fps } = useVideoConfig();
  const windows = lines.map((l) => l.speech);
  return (
    <>
      {musicCues(seconds).map((cue) => (
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
      {clicks.map((at) => (
        <Sequence key={`click-${at}`} from={Math.round(at * fps)} layout="none">
          <Audio src={staticFile("launch/sfx-click.mp3")} volume={0.6} />
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
