import assert from "node:assert/strict";
import { test } from "node:test";
import { POSTS_CARD } from "../launch/wide/posts.ts";
import {
  EP05,
  EP05_BEATS,
  EP05_LINES,
  EP05_REQUEST,
  EP05_SECONDS,
} from "./ep05.ts";
import { timelineProblems } from "./episode.ts";
import { RISE_POSTS } from "./rise.ts";

const spoken = (id: string) => {
  const l = EP05_LINES.find((x) => x.id === id);
  if (!l) throw new Error(`no line ${id}`);
  return l.speech;
};
const landsAt = (i: number) =>
  EP05.carryFrom + i * EP05.carryEvery + EP05.carryDuration;

test("episode 5's timeline is sound", () => {
  assert.deepEqual(timelineProblems(EP05_BEATS, EP05_LINES, EP05_SECONDS), []);
  assert.ok(EP05_SECONDS >= 33 && EP05_SECONDS <= 42);
});

test("the hook's words and swarm are on screen from the first frames", () => {
  assert.ok(EP05.hookWordsAt <= 0.2 && EP05.swarmFrom <= 0.1);
  assert.ok(EP05.swarmBuilt <= spoken("h1")[1] + 0.3);
});

test("the stage opens between the hook and the meet line, and nothing lands during it", () => {
  assert.ok(EP05.stageFrom >= spoken("h1")[1]);
  assert.ok(EP05.stageTo <= spoken("m1")[0] + 0.2);
  assert.ok(EP05.avatarAt >= EP05.stageTo);
});

test("the request is typed while it is said", () => {
  const [start, end] = spoken("w1");
  const typedBy = EP05.requestFrom + EP05_REQUEST.length / EP05.requestCps;
  assert.ok(EP05.requestFrom >= start - 0.3 && typedBy <= end + 0.6);
});

test("the posts land while their making is described, before '3 ready'", () => {
  const [start] = spoken("w2");
  RISE_POSTS.forEach((_, i) => {
    assert.ok(landsAt(i) >= start, `post ${i} lands too early`);
    assert.ok(landsAt(i) + 0.3 <= EP05.readyAt);
  });
});

test("the times appear while 'the best times to post' is said", () => {
  const [start, end] = spoken("w3");
  assert.ok(EP05.timesAt >= start - 0.2 && EP05.timesAt <= end);
});

test("the Approve click lands on 'say yes'", () => {
  const [start, end] = spoken("y1");
  assert.ok(EP05.approveIn < EP05.cursorFrom && EP05.cursorFrom < EP05.click);
  assert.ok(EP05.click >= start && EP05.click <= end + 0.2);
  assert.ok(EP05.scheduledAt > EP05.click);
});

test("the end card shows the address while it is said, with no spoken-form caption", () => {
  const [start, end] = spoken("e2");
  assert.ok(EP05.urlAt >= start - 0.3 && EP05.urlAt <= end);
  assert.ok(EP05.closeFrom >= EP05.scheduledAt + 0.6);
  const e2 = EP05_LINES.find((l) => l.id === "e2");
  assert.equal(
    e2?.captioned,
    false,
    "the end card already shows colony.global",
  );
});

test("captions never cover the posts card", () => {
  assert.ok(POSTS_CARD.y + POSTS_CARD.h <= 940);
});
