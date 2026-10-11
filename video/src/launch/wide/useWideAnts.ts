import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender } from "remotion";
import { drawMarkSilhouette } from "../antShape";
import { INTER, interReady } from "../fonts";
import { mulberry32 } from "../math.ts";
import { pickPoints, sampleAlphaPoints } from "../points.ts";
import { type Ant, createAnts } from "../swarm.ts";
import { WIDE_H, WIDE_W } from "./beat.ts";
import {
  INTRO,
  WIDE_ANT_COUNT,
  WIDE_LANES,
  WIDE_LOGO_RECT,
  WIDE_SEED,
} from "./intro.ts";
import { closeSwarmAnts } from "./closeSwarm.ts";
import { CLOSE_LOGO } from "./film90.ts";
import { drawTower } from "./towerDraw.ts";

function rasterAlpha(
  draw: (ctx: CanvasRenderingContext2D) => void,
): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = WIDE_W;
  canvas.height = WIDE_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  draw(ctx);
  return ctx.getImageData(0, 0, WIDE_W, WIDE_H).data;
}

export type WideSwarms = { opening: Ant[]; close: Ant[] };

/**
 * Samples the pile of jobs and the logo once per render tab, after Inter has
 * loaded, and builds the opening and closing swarms. Holds the frame until
 * they are ready.
 */
export function useWideAnts(): WideSwarms | null {
  const [handle] = useState(() => delayRender("Sampling the wide swarms"));
  const [ants, setAnts] = useState<WideSwarms | null>(null);
  useEffect(() => {
    let live = true;
    interReady
      .then(() => {
        if (!document.fonts.check(`800 100px "${INTER}"`)) {
          throw new Error(
            "Inter 800 is not loaded; refusing to sample a fallback font",
          );
        }
        const rand = mulberry32(WIDE_SEED);
        const letters = sampleAlphaPoints(
          rasterAlpha((ctx) => drawTower(ctx, INTER, INTRO.release, "rest")),
          WIDE_W,
          WIDE_H,
          4,
        );
        const logo = sampleAlphaPoints(
          rasterAlpha((ctx) => drawMarkSilhouette(ctx, WIDE_LOGO_RECT)),
          WIDE_W,
          WIDE_H,
          4,
        );
        const built = createAnts(
          pickPoints(letters, WIDE_ANT_COUNT, rand),
          pickPoints(logo, WIDE_ANT_COUNT, rand),
          WIDE_LANES,
          {
            seed: WIDE_SEED + 1,
            releaseAt: INTRO.release,
            sweep: INTRO.releaseSweep,
            frameWidth: WIDE_W,
          },
        );
        const closeLogo = sampleAlphaPoints(
          rasterAlpha((ctx) => drawMarkSilhouette(ctx, CLOSE_LOGO)),
          WIDE_W,
          WIDE_H,
          4,
        );
        if (live) {
          setAnts({ opening: built, close: closeSwarmAnts(closeLogo) });
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
