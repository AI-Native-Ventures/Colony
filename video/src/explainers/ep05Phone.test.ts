import assert from "node:assert/strict";
import { test } from "node:test";
import { BIG_CAPTIONS } from "../launch/tall/captions.ts";
import { clearOfCovers, insideFeed, TALL_W } from "../launch/tall/frame.ts";
import { SLIM } from "../launch/tall/hero.ts";
import { postLandsAt } from "../launch/wide/posts.ts";
import { EP05, EP05_LINES } from "./ep05.ts";
import {
  APPROVE,
  FEED,
  feedScroll,
  phoneCarryPath,
  phoneCursorKeys,
  slotInView,
  TIME_AT,
} from "./ep05Phone.ts";
import { PHONE_CARD } from "./phone.ts";
import { RISE_POSTS } from "./rise.ts";

const line = (id: string) => {
  const l = EP05_LINES.find((x) => x.id === id);
  if (!l) throw new Error(id);
  return l;
};

/** Seconds post `i` is fully in view between `from` and `to`, at 30 fps. */
function secondsInView(i: number, from: number, to: number): number {
  let n = 0;
  for (let f = Math.ceil(from * 30); f <= to * 30; f++) {
    if (slotInView(i, f / 30)) n++;
  }
  return n / 30;
}

test("the phone card sits under the slim header and above the captions, clear of the buttons", () => {
  assert.ok(clearOfCovers(PHONE_CARD));
  assert.ok(insideFeed(PHONE_CARD));
  assert.ok(PHONE_CARD.y >= SLIM.avatar.y + SLIM.avatar.r + 16);
  assert.ok(PHONE_CARD.y + PHONE_CARD.h <= BIG_CAPTIONS.box.y - 16);
  assert.equal(PHONE_CARD.x + PHONE_CARD.w / 2, TALL_W / 2);
});

test("the first post lands in view; the other two are scrolled into view while the voice describes them", () => {
  assert.ok(slotInView(0, postLandsAt(0, EP05) + 0.45));
  const w2 = line("w2").speech;
  for (const i of [1, 2]) {
    assert.ok(secondsInView(i, w2[0], w2[1]) >= 0.6, `post ${i}`);
  }
});

test("each time is set while its post is in view, during the line about the times", () => {
  const w3 = line("w3").speech;
  RISE_POSTS.forEach((_, i) => {
    assert.ok(TIME_AT[i] >= w3[0] && TIME_AT[i] <= w3[1] + 0.2, `post ${i}`);
    assert.ok(secondsInView(i, TIME_AT[i], TIME_AT[i] + 0.4) >= 0.39);
  });
});

test("the feed never scrolls past the first or the last post", () => {
  for (let f = 0; f <= 33 * 30; f++) {
    const y = feedScroll(f / 30);
    assert.ok(y >= -0.01 && y <= 2 * FEED.step + 0.01, `${y} at ${f}`);
  }
});

test("at the yes, the first post to go out is in view with its time above the pinned Approve, and the pointer ends on it", () => {
  assert.ok(slotInView(0, EP05.click));
  const timeBottom =
    PHONE_CARD.y + FEED.top + FEED.post + FEED.timeGap + FEED.timeH;
  assert.ok(timeBottom <= APPROVE.y - 24, "the time hides under Approve");
  assert.ok(
    APPROVE.x >= PHONE_CARD.x &&
      APPROVE.x + APPROVE.w <= PHONE_CARD.x + PHONE_CARD.w,
  );
  assert.ok(
    APPROVE.y >= PHONE_CARD.y &&
      APPROVE.y + APPROVE.h <= PHONE_CARD.y + PHONE_CARD.h,
  );
  assert.ok(clearOfCovers(APPROVE));
  const keys = phoneCursorKeys(EP05);
  const rest = keys.find((k) => k.at === EP05.click - 0.15);
  assert.ok(rest, "no key at the click");
  assert.ok(rest.x > APPROVE.x && rest.x < APPROVE.x + APPROVE.w);
  assert.ok(rest.y > APPROVE.y && rest.y < APPROVE.y + APPROVE.h);
  assert.ok(keys[0].x > TALL_W, "the pointer comes in from off the frame");
});

test("the ants carrying the posts walk in from off the right edge", () => {
  RISE_POSTS.forEach((_, i) => {
    assert.ok(phoneCarryPath(i)[0].x > TALL_W + 30, `post ${i}`);
  });
});
