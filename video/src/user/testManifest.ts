import { type Box, SHOT_BOXES, SHOT_IDS, viewportOf } from "./manifest.ts";

const MID: Box = { x: 620, y: 420, w: 200, h: 40 };

/** For tests: a manifest with every shot and box the videos need, each box where `box` puts it. */
export function fixtureManifest(
  box: (shot: string, name: string) => Box = () => MID,
) {
  return {
    capturedAt: "2026-10-12T12:00:00.000Z",
    appCommit: "abc1234",
    shots: Object.fromEntries(
      SHOT_IDS.map((id) => [
        id,
        {
          file: `${id}.png`,
          width: viewportOf(id).w,
          height: viewportOf(id).h,
          boxes: Object.fromEntries(
            SHOT_BOXES[id].map((name) => [name, box(id, name)]),
          ),
        },
      ]),
    ),
  };
}
