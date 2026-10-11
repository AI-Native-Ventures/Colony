import { smoothstep } from "./math.ts";

export type DuckOptions = {
  /** Music level with no voice. */
  base: number;
  /** Music level under a voice line. */
  ducked: number;
  /** Seconds the dip starts before a line, so the first word lands on low music. */
  attack: number;
  /** Seconds the music takes to come back after a line. */
  release: number;
};

/** Music volume at `t` seconds, dipping smoothly under every voice window. */
export function musicVolume(
  t: number,
  windows: ReadonlyArray<readonly [number, number]>,
  opts: DuckOptions,
): number {
  let depth = 0;
  for (const [from, to] of windows) {
    const down = smoothstep(from - opts.attack, from, t);
    const up = 1 - smoothstep(to, to + opts.release, t);
    depth = Math.max(depth, Math.min(down, up));
  }
  return opts.base + (opts.ducked - opts.base) * depth;
}
