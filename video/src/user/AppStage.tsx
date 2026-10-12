import { Img, staticFile } from "remotion";
import type { Camera } from "./camera.ts";
import type { Manifest, ShotId } from "./manifest.ts";
import { FRAME, WINDOW } from "./stage.ts";

/** One captured screen filling the app window. */
function ShotImage({
  manifest,
  shot,
  opacity,
}: {
  manifest: Manifest;
  shot: ShotId;
  opacity: number;
}) {
  return (
    <Img
      src={staticFile(`user/${manifest.shots[shot].file}`)}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        opacity,
      }}
    />
  );
}

/**
 * The app window on the stage, the camera's transform on it: the shot on
 * screen, fading in over the one before.
 */
export const AppStage: React.FC<{
  manifest: Manifest;
  camera: Camera;
  shot: ShotId;
  previous?: ShotId;
  mix: number;
  opacity: number;
}> = ({ manifest, camera, shot, previous, mix, opacity }) => (
  <div
    style={{
      position: "absolute",
      left: 0,
      top: 0,
      width: FRAME.w,
      height: FRAME.h,
      transform: `translate(${camera.x.toFixed(3)}px, ${camera.y.toFixed(3)}px) scale(${camera.scale.toFixed(5)})`,
      transformOrigin: "0 0",
      opacity,
    }}
  >
    <div
      style={{
        position: "absolute",
        left: WINDOW.x,
        top: WINDOW.y,
        width: WINDOW.w,
        height: WINDOW.h,
        borderRadius: 18,
        overflow: "hidden",
        background: "#ffffff",
        boxShadow:
          "0 40px 90px -40px rgb(40 20 80 / 0.55), 0 0 0 1px rgb(23 21 31 / 0.08)",
      }}
    >
      {previous && mix < 1 ? (
        <ShotImage manifest={manifest} shot={previous} opacity={1} />
      ) : null}
      <ShotImage manifest={manifest} shot={shot} opacity={mix} />
    </div>
  </div>
);

/** A soft violet ring that pulses around the next thing clicked. Frame pixels. */
export const ClickRing: React.FC<{
  box: { x: number; y: number; w: number; h: number };
  strength: number;
}> = ({ box, strength }) =>
  strength <= 0 ? null : (
    <div
      style={{
        position: "absolute",
        left: box.x - 8,
        top: box.y - 8,
        width: box.w + 16,
        height: box.h + 16,
        borderRadius: 16,
        border: `3px solid hsl(258 90% 66% / ${(0.85 * strength).toFixed(3)})`,
        boxShadow: `0 0 0 ${(10 * strength).toFixed(2)}px hsl(258 90% 66% / ${(0.14 * strength).toFixed(3)})`,
      }}
    />
  );
