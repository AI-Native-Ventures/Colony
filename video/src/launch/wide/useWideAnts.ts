import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender } from "remotion";
import { drawMarkSilhouette } from "../antShape";
import { INTER, interReady } from "../fonts";
import { mulberry32 } from "../math.ts";
import { pickPoints, sampleAlphaPoints } from "../points.ts";
import { type Ant, createAnts } from "../swarm.ts";
import { WIDE_H, WIDE_W } from "./beat.ts";
import { closeSwarmAnts } from "./closeSwarm.ts";
import { CLOSE_LOGO } from "./film90.ts";
import {
  INTRO,
  type OpeningLayout,
  WIDE_ANT_COUNT,
  WIDE_OPENING,
  WIDE_SEED,
} from "./intro.ts";
import { drawTower } from "./towerDraw.ts";

function rasterAlpha(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  draw(ctx);
  return ctx.getImageData(0, 0, width, height).data;
}

function assertInter(): void {
  if (!document.fonts.check(`800 100px "${INTER}"`)) {
    throw new Error(
      "Inter 800 is not loaded; refusing to sample a fallback font",
    );
  }
}

/** The opening swarm for a layout: ants from the pile of jobs to the logo, along its lanes. */
function openingSwarm(layout: OpeningLayout): Ant[] {
  const { w, h } = layout;
  const rand = mulberry32(WIDE_SEED);
  const letters = sampleAlphaPoints(
    rasterAlpha(w, h, (ctx) =>
      drawTower(ctx, INTER, INTRO.release, "rest", layout),
    ),
    w,
    h,
    4,
  );
  const logo = sampleAlphaPoints(
    rasterAlpha(w, h, (ctx) => drawMarkSilhouette(ctx, layout.logo)),
    w,
    h,
    4,
  );
  return createAnts(
    pickPoints(letters, WIDE_ANT_COUNT, rand),
    pickPoints(logo, WIDE_ANT_COUNT, rand),
    layout.lanes,
    {
      seed: WIDE_SEED + 1,
      releaseAt: INTRO.release,
      sweep: INTRO.releaseSweep,
      frameWidth: w,
    },
  );
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
        assertInter();
        const built = openingSwarm(WIDE_OPENING);
        const closeLogo = sampleAlphaPoints(
          rasterAlpha(WIDE_W, WIDE_H, (ctx) =>
            drawMarkSilhouette(ctx, CLOSE_LOGO),
          ),
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

/** The opening swarm alone, for another layout (the Reels film's). Holds the frame until it is ready. */
export function useOpeningAnts(layout: OpeningLayout): Ant[] | null {
  const [handle] = useState(() => delayRender("Sampling the opening swarm"));
  const [ants, setAnts] = useState<Ant[] | null>(null);
  useEffect(() => {
    let live = true;
    interReady
      .then(() => {
        assertInter();
        const built = openingSwarm(layout);
        if (live) {
          setAnts(built);
          continueRender(handle);
        }
      })
      .catch((err: unknown) => cancelRender(err));
    return () => {
      live = false;
    };
  }, [handle, layout]);
  return ants;
}
