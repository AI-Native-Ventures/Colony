import type { Point } from "../points.ts";
import type { Path } from "./walk.ts";

export type Post = {
  id: string;
  /** When the post is set to go out. */
  when: string;
};

/** Three example posts for Bright Plumbing, drawn in code. */
export const POSTS: Post[] = [
  { id: "leak", when: "Mon 8:00" },
  { id: "geyser", when: "Wed 12:30" },
  { id: "review", when: "Fri 17:00" },
];

/** The posts card, in panel pixels. */
export const POSTS_CARD = { x: 860, y: 190, w: 940, h: 640 };
export const POST_SIZE = 264;
const POST_GAP = 22;
const POSTS_TOP = 236;

/** Top left of post `i`, panel pixels. */
export function postSlot(i: number): Point {
  return {
    x: POSTS_CARD.x + 52 + i * (POST_SIZE + POST_GAP),
    y: POSTS_CARD.y + POSTS_TOP,
  };
}

/** Where post `i`'s ant settles: under the post, beside its time. */
export function postOwnerSpot(i: number): Point {
  const slot = postSlot(i);
  return { x: slot.x + 30, y: slot.y + POST_SIZE + 46 };
}

/**
 * A carrier comes up from the bottom right corner, right of the subtitles,
 * then walks left under the card to its post.
 */
export function postCarryPath(i: number): Path {
  const end = postOwnerSpot(i);
  return [
    { x: 1840 + i * 50, y: 1150 },
    { x: 1720, y: 760 },
    { x: end.x + 140, y: 880 },
    end,
  ];
}

export type PostTiming = {
  carryFrom: number;
  carryEvery: number;
  carryDuration: number;
};

export function postCarryStart(i: number, timing: PostTiming): number {
  return timing.carryFrom + i * timing.carryEvery;
}

export function postLandsAt(i: number, timing: PostTiming): number {
  return postCarryStart(i, timing) + timing.carryDuration;
}

/** Posts in place so far. */
export function postsLanded(t: number, timing: PostTiming): number {
  return POSTS.filter((_, i) => t >= postLandsAt(i, timing)).length;
}
