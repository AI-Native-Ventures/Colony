import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY90 } from "./film90.ts";
import { TEAM } from "./employees.ts";
import {
  chipLeft,
  chipShowsAt,
  chipWidth,
  clockLabel,
  hourX,
  RULER,
  TEAM_CHIPS,
  YOU_BLOCKS,
} from "./day.ts";

test("the clock runs from 07:00 to 18:00", () => {
  assert.equal(clockLabel(DAY90.clockFrom - 1, DAY90), "07:00");
  assert.equal(clockLabel(DAY90.clockFrom, DAY90), "07:00");
  assert.equal(clockLabel(DAY90.clockTo, DAY90), "18:00");
  assert.equal(clockLabel(DAY90.clockTo + 2, DAY90), "18:00");
});

test("the clock never runs backwards", () => {
  let prev = "";
  for (let t = DAY90.clockFrom - 0.5; t <= DAY90.clockTo + 0.5; t += 1 / 30) {
    const label = clockLabel(t, DAY90);
    assert.ok(label >= prev, `${label} after ${prev}`);
    prev = label;
  }
});

test("each employee has its own lane, and its chips never overlap", () => {
  for (const who of TEAM) {
    const chips = TEAM_CHIPS.filter((c) => c.who === who).sort(
      (a, b) => a.at - b.at,
    );
    assert.ok(chips.length >= 1, `${who} has nothing to show`);
    for (let i = 1; i < chips.length; i++) {
      assert.ok(
        hourX(chips[i - 1].at) + 24 <= chipLeft(chips[i]),
        `${chips[i].text} overlaps`,
      );
    }
  }
});

test("chips trail their ant: they end where the clock is when they appear", () => {
  for (const chip of TEAM_CHIPS) {
    assert.equal(chipLeft(chip) + chipWidth(chip.text), hourX(chip.at));
  }
});

test("no chip runs off the frame or into the lane labels", () => {
  for (const chip of TEAM_CHIPS) {
    assert.ok(chipLeft(chip) >= RULER.x0 - 20, `${chip.text} hits the labels`);
    assert.ok(hourX(chip.at) <= 1880, `${chip.text} runs off the frame`);
  }
});

test("every chip shows up before the day's summary", () => {
  for (const chip of TEAM_CHIPS) {
    assert.ok(chipShowsAt(chip, DAY90) <= DAY90.summaryAt - 0.2, chip.text);
  }
});

test("your own work fits inside the day", () => {
  for (const block of YOU_BLOCKS) {
    assert.ok(block.from >= 7 && block.to <= 18 && block.from < block.to);
  }
});
