import assert from "node:assert/strict";
import { test } from "node:test";
import { bezier } from "../swarm.ts";
import { WIDE_H } from "./beat.ts";
import {
  POSTS,
  postCarryPath,
  postLandsAt,
  postOwnerSpot,
  postsLanded,
  postSlot,
} from "./posts.ts";

const timing = { carryFrom: 10, carryEvery: 0.5, carryDuration: 1.2 };

test("there are three posts", () => {
  assert.equal(POSTS.length, 3);
});

test("each carrier walks from below the frame to its own post", () => {
  POSTS.forEach((_, i) => {
    const path = postCarryPath(i);
    assert.ok(path[0].y > WIDE_H, "starts on screen");
    assert.deepEqual(path[3], postOwnerSpot(i));
  });
});

test("posts sit side by side without overlapping", () => {
  for (let i = 1; i < POSTS.length; i++) {
    assert.ok(postSlot(i).x >= postSlot(i - 1).x + 264);
  }
});

test("posts land one after another", () => {
  for (let i = 1; i < POSTS.length; i++) {
    assert.ok(postLandsAt(i, timing) > postLandsAt(i - 1, timing));
  }
});

test("the ready count goes from 0 to 3 and never down", () => {
  assert.equal(postsLanded(timing.carryFrom, timing), 0);
  let prev = 0;
  for (let t = 9; t < 15; t += 1 / 30) {
    const n = postsLanded(t, timing);
    assert.ok(n >= prev);
    prev = n;
  }
  assert.equal(prev, 3);
});

test("carriers stay clear of the subtitles at the bottom", () => {
  POSTS.forEach((_, i) => {
    const [p0, p1, p2, p3] = postCarryPath(i);
    for (let k = 0; k <= 200; k++) {
      const p = bezier(p0, p1, p2, p3, k / 200);
      const underSubtitles = p.x >= 400 && p.x <= 1520 && p.y >= 900;
      assert.ok(
        !underSubtitles,
        `post ${i} carrier at ${p.x.toFixed(0)},${p.y.toFixed(0)}`,
      );
    }
  });
});
