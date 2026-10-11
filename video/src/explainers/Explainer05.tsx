import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { easeInOutCubic, progress } from "../launch/math.ts";
import { useFontsReady } from "../launch/useFontsReady";
import { BrightStage } from "../launch/wide/BrightStage";
import { EmployeeHero } from "../launch/wide/EmployeeHero";
import { LOOKS, TONES } from "../launch/wide/employees.ts";
import { LightWorld } from "../launch/wide/MeshGradient";
import type { PaletteStop } from "../launch/wide/mesh.ts";
import { PanelBlooms } from "../launch/wide/PanelBlooms";
import { EP05 } from "./ep05.ts";
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
      <BrightStage
        reveal={reveal}
        cx={960}
        cy={540}
        blooms={false}
        transition="fade"
      >
        <PanelBlooms tone={TONES.pink} />
        <EmployeeHero t={t} look={LOOKS.pink} timing={EP05} />
        <RisePostsCard t={t} />
        <RisePostCarriers t={t} />
        <ApproveCursor t={t} />
      </BrightStage>
    </AbsoluteFill>
  );
};
