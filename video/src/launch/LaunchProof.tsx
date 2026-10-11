import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop, Grain, Vignette } from "./Backdrop";
import { easeInOutCubic, progress } from "./math.ts";
import { Opening } from "./Opening";
import { PROOF_SECONDS, T_LOGO_IN, timeAt } from "./timeline.ts";
import { useAnts } from "./useAnts";

/** The silent look proof: the film's opening on its own. */
export const LaunchProof: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = timeAt(frame, fps);
  const ants = useAnts();
  const push = 1 + 0.045 * easeInOutCubic(t / PROOF_SECONDS);
  const punch = 1 + 0.018 * Math.sin(Math.PI * progress(t, T_LOGO_IN, 0.5));
  return (
    <AbsoluteFill style={{ backgroundColor: "#060509" }}>
      <Backdrop />
      <AbsoluteFill
        style={{ transform: `scale(${(push * punch).toFixed(5)})` }}
      >
        <Opening t={t} ants={ants} />
      </AbsoluteFill>
      <Vignette />
      <Grain t={t} />
    </AbsoluteFill>
  );
};
