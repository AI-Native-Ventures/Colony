import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender } from "remotion";
import { drawMarkSilhouette } from "./antShape";
import { INTER, interReady } from "./fonts";
import { mulberry32 } from "./math.ts";
import { pickPoints, sampleAlphaPoints } from "./points.ts";
import { type Ant, createAnts } from "./swarm.ts";
import {
  ANT_COUNT,
  FRAME_H,
  FRAME_W,
  LANES,
  LOGO_RECT,
  RELEASE_SWEEP,
  SEED,
  T_RELEASE,
} from "./timeline.ts";
import { drawWords } from "./words";

function rasterAlpha(
  draw: (ctx: CanvasRenderingContext2D) => void,
): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = FRAME_W;
  canvas.height = FRAME_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  draw(ctx);
  return ctx.getImageData(0, 0, FRAME_W, FRAME_H).data;
}

/**
 * Samples the letters and the logo once per render tab, after Inter has
 * loaded, and builds the swarm. Holds the frame until it is ready.
 */
export function useAnts(): Ant[] | null {
  const [handle] = useState(() => delayRender("Sampling swarm target points"));
  const [ants, setAnts] = useState<Ant[] | null>(null);
  useEffect(() => {
    let live = true;
    interReady
      .then(() => {
        if (!document.fonts.check(`800 100px "${INTER}"`)) {
          throw new Error(
            "Inter 800 is not loaded; refusing to sample a fallback font",
          );
        }
        const rand = mulberry32(SEED);
        const letters = sampleAlphaPoints(
          rasterAlpha((ctx) => drawWords(ctx, INTER, T_RELEASE, "rest")),
          FRAME_W,
          FRAME_H,
          5,
        );
        const logo = sampleAlphaPoints(
          rasterAlpha((ctx) => drawMarkSilhouette(ctx, LOGO_RECT)),
          FRAME_W,
          FRAME_H,
          6,
        );
        const built = createAnts(
          pickPoints(letters, ANT_COUNT, rand),
          pickPoints(logo, ANT_COUNT, rand),
          LANES,
          {
            seed: SEED + 1,
            releaseAt: T_RELEASE,
            sweep: RELEASE_SWEEP,
            frameWidth: FRAME_W,
          },
        );
        if (live) {
          setAnts(built);
          continueRender(handle);
        }
      })
      .catch((err: unknown) => cancelRender(err));
    return () => {
      live = false;
    };
  }, [handle]);
  return ants;
}
