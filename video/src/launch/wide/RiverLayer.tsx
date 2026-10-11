import { AVATAR, BEAT } from "./beat.ts";
import { River } from "./River";
import type { RiverSpec } from "./riverAnts.ts";

/** The proof beat's blue river, from off the left edge into the avatar. */
export const BLUE_PROOF_RIVER: RiverSpec = {
  color: "rgb(60 131 246)",
  seed: 7101,
  count: 220,
  from: { x0: -320, x1: -40, y0: 640, y1: 1020 },
  lane: { c1: { x: 1500, y: 1180 }, c2: { x: 1250, y: -160 }, spread: 170 },
  target: { x: AVATAR.x, y: AVATAR.y },
  startAt: BEAT.riverFrom,
  landAt: BEAT.avatarAt,
};

export const RiverLayer: React.FC<{ t: number }> = ({ t }) => (
  <River t={t} spec={BLUE_PROOF_RIVER} />
);
