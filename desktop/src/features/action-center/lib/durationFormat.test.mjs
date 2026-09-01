import assert from "node:assert/strict";
import test from "node:test";

import {
  formatCountdownMinutes,
  formatDurationCoarse,
} from "./durationFormat.ts";

test("formatDurationCoarse: under a minute reads just now", () => {
  assert.equal(formatDurationCoarse(0), "just now");
  assert.equal(formatDurationCoarse(59), "just now");
});

test("formatDurationCoarse: minutes, hours, days tiers", () => {
  assert.equal(formatDurationCoarse(60), "1m");
  assert.equal(formatDurationCoarse(59 * 60), "59m");
  assert.equal(formatDurationCoarse(3_600), "1h");
  assert.equal(formatDurationCoarse(23 * 3_600), "23h");
  assert.equal(formatDurationCoarse(86_400), "1d");
  assert.equal(formatDurationCoarse(2 * 86_400 + 3_600), "2d");
});

test("formatDurationCoarse: negative input clamps to just now, never a negative label", () => {
  assert.equal(formatDurationCoarse(-500), "just now");
});

test("formatCountdownMinutes: under a minute reads less than a minute, not 0m", () => {
  assert.equal(formatCountdownMinutes(0), "less than a minute");
  assert.equal(formatCountdownMinutes(59), "less than a minute");
});

test("formatCountdownMinutes: minutes only under an hour", () => {
  assert.equal(formatCountdownMinutes(60), "1m");
  assert.equal(formatCountdownMinutes(40 * 60), "40m");
});

test("formatCountdownMinutes: hours and minutes combined", () => {
  assert.equal(formatCountdownMinutes(60 * 60 + 40 * 60), "1h 40m");
});

test("formatCountdownMinutes: an exact hour omits the minutes clause", () => {
  assert.equal(formatCountdownMinutes(2 * 60 * 60), "2h");
});

test("formatCountdownMinutes: never shows seconds, even with a remainder", () => {
  assert.equal(formatCountdownMinutes(60 * 60 + 40 * 60 + 45), "1h 40m");
});

test("formatCountdownMinutes: negative input (past the deadline) never prints a negative countdown", () => {
  assert.equal(formatCountdownMinutes(-10), "less than a minute");
});
