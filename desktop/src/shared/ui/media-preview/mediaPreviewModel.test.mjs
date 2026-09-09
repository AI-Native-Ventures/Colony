import assert from "node:assert/strict";
import test from "node:test";
import {
  clampMediaIndex,
  formatMediaTime,
  isBundledPreviewDownload,
  mediaStageRatio,
  mediaSwipeDirection,
} from "./mediaPreviewModel.ts";

test("carousel navigation remains valid after a collection shrinks", () => {
  assert.equal(clampMediaIndex(4, 2), 1);
  assert.equal(clampMediaIndex(-1, 3), 0);
  assert.equal(clampMediaIndex(Number.NaN, 3), 0);
  assert.equal(clampMediaIndex(3, 0), 0);
});
test("carousel swipes preserve normal vertical thread scrolling", () => {
  assert.equal(mediaSwipeDirection(-90, 6), 1);
  assert.equal(mediaSwipeDirection(90, 6), -1);
  assert.equal(mediaSwipeDirection(-25, 0), 0);
  assert.equal(mediaSwipeDirection(-60, 90), 0);
  assert.equal(mediaSwipeDirection(-60, 50), 0);
});
test("mixed-aspect carousel reserves one stable stage while singles use their dimensions", () => {
  assert.equal(mediaStageRatio(3, 1080, 1080), mediaStageRatio(3, 900, 1200));
  assert.equal(mediaStageRatio(1, 900, 1200), 0.75);
  assert.equal(mediaStageRatio(1, 1440, 900), 1.6);
  assert.equal(mediaStageRatio(1, 1, 10000), 0.0001);
  assert.equal(mediaStageRatio(1, 12000, 1000), 12);
  assert.equal(mediaStageRatio(1, Number.NaN, 100), 4 / 3);
});
test("audio time is stable while metadata is unknown or invalid", () => {
  assert.equal(formatMediaTime(65.8), "1:05");
  assert.equal(formatMediaTime(-3), "0:00");
  assert.equal(formatMediaTime(Number.POSITIVE_INFINITY), "0:00");
});

test("only bundled fixture filenames bypass the native save path", () => {
  assert.equal(isBundledPreviewDownload("/rich-previews/launch-01.svg"), true);
  for (const url of [
    "/rich-previews/../private.txt",
    "//evil.example/x",
    "https://evil.example/rich-previews/x.svg",
    "/rich-previews/x.svg?redirect=evil",
    "/rich-previews/%2e%2e/private",
  ]) {
    assert.equal(isBundledPreviewDownload(url), false);
  }
});
