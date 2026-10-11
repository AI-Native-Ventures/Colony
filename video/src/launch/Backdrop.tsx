import { useLayoutEffect, useRef } from "react";
import { mulberry32 } from "./math.ts";
import { FRAME_H, FRAME_W } from "./timeline.ts";

/** Near black with a hint of violet, never flat black. */
export const Backdrop: React.FC = () => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      background:
        "radial-gradient(120% 75% at 50% 42%, #1a142b 0%, #0d0b15 52%, #060509 100%)",
    }}
  />
);

export const Vignette: React.FC = () => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      background:
        "radial-gradient(110% 70% at 50% 45%, transparent 55%, rgb(0 0 0 / 0.55) 100%)",
    }}
  />
);

/** Film grain that changes 24 times a second whatever the frame rate; drawn at half size and stretched. */
export const Grain: React.FC<{
  t: number;
  width?: number;
  height?: number;
  opacity?: number;
}> = ({ t, width = FRAME_W, height = FRAME_H, opacity = 0.06 }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const tick = Math.floor(t * 24);
  const gw = Math.round(width / 2);
  const gh = Math.round(height / 2);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(gw, gh);
    const rand = mulberry32(9001 + tick);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.floor(rand() * 256);
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [tick, gw, gh]);
  return (
    <canvas
      ref={ref}
      width={gw}
      height={gh}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width,
        height,
        opacity,
        mixBlendMode: "overlay",
      }}
    />
  );
};
