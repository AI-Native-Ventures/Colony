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
import { BrightStage } from "./BrightStage";
import {
  AVATAR,
  BEAT,
  BEAT_SECONDS,
  BEAT_VOICE,
  CAMERA,
  cameraScale,
  LEADS,
  landsAt,
  WIDE_H,
  WIDE_W,
} from "./beat.ts";
import { EmployeeIntro } from "./EmployeeIntro";
import { Carriers, LeadsBoard } from "./LeadsBoard";
import { RiverLayer } from "./RiverLayer";
import { Subtitles } from "./Subtitles";

const KEYWORDS = new Set([
  "finds",
  "customers.",
  "Twenty",
  "offices",
  "plumber,",
  "first",
  "coffee.",
]);
const WINDOWS = BEAT_VOICE.map((line) => line.speech);
const DUCK = { base: 0.5, ducked: 0.18, attack: 0.25, release: 0.4 };

/** Proof beat for the 90 s film: the blue river becomes the employee who finds customers. */
export const TeamBeatProof: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const reveal = easeInOutCubic(
    progress(t, BEAT.brightFrom, BEAT.brightTo - BEAT.brightFrom),
  );
  const camera = cameraScale(t);
  return (
    <AbsoluteFill style={{ backgroundColor: "#060509" }}>
      <Backdrop />
      <div style={{ position: "absolute", inset: 0, opacity: 1 - reveal }}>
        <Vignette />
      </div>
      <AbsoluteFill
        style={{
          transform: `scale(${camera.toFixed(5)})`,
          transformOrigin: `${CAMERA.focusX}px ${CAMERA.focusY}px`,
        }}
      >
        <BrightStage reveal={reveal} cx={AVATAR.x} cy={AVATAR.y}>
          <EmployeeIntro t={t} />
          <LeadsBoard t={t} />
          <Carriers t={t} />
          <Subtitles t={t} lines={BEAT_VOICE} keywords={KEYWORDS} />
        </BrightStage>
        <RiverLayer t={t} />
      </AbsoluteFill>
      <Grain
        t={t}
        width={WIDE_W}
        height={WIDE_H}
        opacity={0.06 - 0.03 * reveal}
      />
      <Audio
        src={staticFile("launch/music-b.mp3")}
        startFrom={Math.round(7 * fps)}
        volume={(f) =>
          musicVolume(f / fps, WINDOWS, DUCK) *
          (1 - smoothstep(BEAT_SECONDS - 0.8, BEAT_SECONDS, f / fps))
        }
      />
      <Sequence
        from={Math.max(0, Math.round(BEAT.riverFrom * fps))}
        layout="none"
      >
        <Audio src={staticFile("launch/sfx-whoosh.mp3")} volume={0.55} />
      </Sequence>
      {BEAT_VOICE.map((line) => (
        <Sequence key={line.id} from={Math.round(line.at * fps)} layout="none">
          <Audio src={staticFile(line.file)} />
        </Sequence>
      ))}
      {LEADS.map((lead, i) => (
        <Sequence
          key={lead.name}
          from={Math.round(landsAt(i) * fps)}
          layout="none"
        >
          <Audio src={staticFile("launch/sfx-pop.mp3")} volume={0.45} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
