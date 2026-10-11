import {
  AbsoluteFill,
  Audio,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { AppWindow } from "./app/AppWindow";
import { BusinessForm } from "./app/BusinessForm";
import { Captions } from "./app/Captions";
import { OutreachApprove } from "./app/OutreachApprove";
import { TeamChart } from "./app/TeamChart";
import { sceneVisibility } from "./app/ui.ts";
import { Backdrop, Grain, Vignette } from "./Backdrop";
import { musicVolume } from "./duck.ts";
import { EndCard } from "./EndCard";
import { SCENES, VO_LINES } from "./film.ts";
import { easeInOutCubic, progress, smoothstep } from "./math.ts";
import { Opening } from "./Opening";
import { T_LOGO_IN, timeAt } from "./timeline.ts";
import { useAnts } from "./useAnts";

const VOICE_WINDOWS = VO_LINES.map((line) => line.speech);
const DUCK = { base: 0.55, ducked: 0.2, attack: 0.25, release: 0.4 };

/** The 30 second launch film: opening, the real app in three scenes, end card, voice and music. */
export const LaunchFilm: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = timeAt(frame, fps);
  const ants = useAnts();
  const openingOut = 1 - smoothstep(9.0, 9.6, t);
  const push = 1 + 0.045 * easeInOutCubic(Math.min(1, t / SCENES.opening.end));
  const punch = 1 + 0.018 * Math.sin(Math.PI * progress(t, T_LOGO_IN, 0.5));
  const business = sceneVisibility(t, SCENES.business);
  const team = sceneVisibility(t, SCENES.team);
  const approve = sceneVisibility(t, SCENES.approve);
  return (
    <AbsoluteFill style={{ backgroundColor: "#060509" }}>
      <Backdrop />
      {openingOut > 0 ? (
        <AbsoluteFill
          style={{
            opacity: openingOut,
            transform: `scale(${(push * punch).toFixed(5)})`,
          }}
        >
          <Opening t={t} ants={ants} />
        </AbsoluteFill>
      ) : null}
      <AppWindow t={t}>
        {business > 0 ? <BusinessForm t={t} opacity={business} /> : null}
        {team > 0 ? <TeamChart t={t} opacity={team} /> : null}
        {approve > 0 ? <OutreachApprove t={t} opacity={approve} /> : null}
      </AppWindow>
      <Captions t={t} />
      <EndCard t={t} />
      <Vignette />
      <Grain t={t} />
      <Audio
        src={staticFile("launch/music-b.mp3")}
        volume={(f) => musicVolume(f / fps, VOICE_WINDOWS, DUCK)}
      />
      {VO_LINES.map((line) => (
        <Sequence key={line.id} from={Math.round(line.at * fps)} layout="none">
          <Audio src={staticFile(line.file)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
