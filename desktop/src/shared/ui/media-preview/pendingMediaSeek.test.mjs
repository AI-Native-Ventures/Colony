import assert from "node:assert/strict";
import test from "node:test";
import { applyPendingMediaSeek } from "./pendingMediaSeek.ts";

test("cold review media keeps the restore queued until metadata arrives", () => {
  const media = { readyState: 0, currentTime: 0 };
  const savedSeconds = 3;
  assert.equal(applyPendingMediaSeek(media, savedSeconds), false);
  assert.equal(media.currentTime, 0);
  media.readyState = 1;
  assert.equal(applyPendingMediaSeek(media, savedSeconds), true);
  assert.equal(media.currentTime, savedSeconds);
});

test("warm media can restore to the start and an absent seek stays untouched", () => {
  const media = { readyState: 4, currentTime: 3 };
  assert.equal(applyPendingMediaSeek(media, null), false);
  assert.equal(media.currentTime, 3);
  assert.equal(applyPendingMediaSeek(media, 0), true);
  assert.equal(media.currentTime, 0);
});
