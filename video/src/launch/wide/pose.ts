/** Past this far left of vertical, an ant is drawn mirrored instead of rotated upside down. */
const MIRROR_COS = -0.5;

export type AntPose = {
  /** Degrees for CSS rotate(), applied after the mirror. */
  rotate: number;
  /** Draw the side-view mark flipped left to right. */
  mirrored: boolean;
};

function wrap(deg: number): number {
  return (((deg % 360) + 540) % 360) - 180;
}

/**
 * How to draw a side-view ant whose nose points along `angle` (radians, 0 =
 * right): rotated when heading right or up or down, mirrored when heading
 * left, so its legs stay underneath instead of on top.
 */
export function antPose(angle: number): AntPose {
  const deg = (angle * 180) / Math.PI;
  if (Math.cos(angle) < MIRROR_COS) {
    return { rotate: wrap(deg - 180), mirrored: true };
  }
  return { rotate: deg, mirrored: false };
}
