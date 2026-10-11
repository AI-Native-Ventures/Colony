/** One walk cycle of the brand ant, in seconds (desktop animations.css "Colony ant gait"). */
export const GAIT_SECONDS = 0.42;

/**
 * Leg tripod rotations in degrees and body bob as a fraction of the ant's
 * height, at a gait phase (cycles, any real number). Tripod A swings 0 to -5
 * and back while tripod B does the opposite; the body lifts 1% on the
 * quarter steps. Matches the brand CSS keyframes, eased like ease-in-out.
 */
export function legAngles(phase: number): {
  a: number;
  b: number;
  bob: number;
} {
  const p = phase - Math.floor(phase);
  const wave = 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
  // `0 - x` keeps a resting leg at 0 rather than -0.
  return {
    a: 0 - 5 * wave,
    b: 0 - 5 * (1 - wave),
    bob: 0 - 0.01 * Math.abs(Math.sin(2 * Math.PI * p)),
  };
}
