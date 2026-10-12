import { Audio, Sequence, staticFile, useVideoConfig } from "remotion";
import { musicVolume } from "../duck.ts";
import { smoothstep } from "../math.ts";
import { LEADS, landsAt } from "./beat.ts";
import { chipShowsAt, TEAM_CHIPS } from "./day.ts";
import { emailTypedAt } from "./email.ts";
import {
  AMBER90,
  BLUE90,
  CLOSE90,
  DAY90,
  GREEN90,
  LINES,
  PANS,
  PINK90,
  SCOUT90,
  YES90,
} from "./film90.ts";
import { HOW, TEAM_ROWS, teamRowAt } from "./how.ts";
import { INTRO } from "./intro.ts";
import { POSTS, postLandsAt } from "./posts.ts";
import { SCOUT_TASKS, taskLandsAt } from "./scout.ts";
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

/** Everything the launch film plays: music, sound effects and the voice, at the film's times. */
export const FilmSound: React.FC = () => {
  const { fps } = useVideoConfig();
  return (
    <>
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
    </>
  );
};
