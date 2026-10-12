import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY_END, DAY_START, TEAM_CHIPS, YOU_BLOCKS } from "../wide/day.ts";
import { TEAM } from "../wide/employees.ts";
import { clearOfCovers, insideFeed, TALL_W } from "./frame.ts";
import {
  chipTops,
  hourY,
  SUMMARY_ROWS,
  summaryBox,
  TALL_DAY,
  tallDayAntSpot,
  youBlockLines,
} from "./day.ts";

const D = TALL_DAY;

test("the clock, the columns and the summary sit in the visible frame, clear of the buttons", () => {
  const boxes = {
    clock: { x: D.clock.x, y: D.clock.y, w: 420, h: D.clock.size * 1.1 },
    heads: {
      x: D.you.x,
      y: D.heads.y,
      w: D.team.x + D.team.w - D.you.x,
      h: 44,
    },
    you: {
      x: D.you.x,
      y: D.ruler.top,
      w: D.you.w,
      h: D.ruler.bottom - D.ruler.top,
    },
    team: {
      x: D.team.x,
      y: D.ruler.top,
      w: D.team.w,
      h: D.ruler.bottom - D.ruler.top,
    },
    summary: summaryBox(),
  };
  for (const [name, box] of Object.entries(boxes)) {
    assert.ok(clearOfCovers(box), `${name} is under Instagram's buttons`);
    assert.ok(insideFeed(box), `${name} leaves the feed crop`);
    assert.ok(
      box.x >= 0 && box.x + box.w <= TALL_W,
      `${name} leaves the frame`,
    );
  }
});

test("the hours run down the page, 07:00 at the top and 18:00 at the bottom", () => {
  assert.equal(hourY(DAY_START), D.ruler.top);
  assert.equal(hourY(DAY_END), D.ruler.bottom);
  for (let h = DAY_START; h < DAY_END; h += 0.25)
    assert.ok(hourY(h + 0.25) > hourY(h));
});

test("the team's chips never overlap, and each sits between 07:00 and its own time", () => {
  const tops = chipTops(TEAM_CHIPS);
  assert.equal(tops.length, TEAM_CHIPS.length);
  TEAM_CHIPS.forEach((chip, i) => {
    assert.ok(tops[i] >= hourY(DAY_START), `${chip.text} is above 07:00`);
    assert.ok(
      tops[i] + D.chip.h <= hourY(chip.at) + 0.5,
      `${chip.text} hangs below its time`,
    );
    if (i > 0)
      assert.ok(
        tops[i] >= tops[i - 1] + D.chip.h + D.chip.gap,
        `${chip.text} overlaps`,
      );
  });
});

test("each of your jobs is tall enough for its words", () => {
  for (const block of YOU_BLOCKS) {
    const lines = youBlockLines(block.text);
    const height = hourY(block.to) - hourY(block.from);
    assert.ok(lines.length >= 1 && lines.length <= 2, block.text);
    assert.ok(
      lines.length * D.block.lineHeight + 2 * D.block.pad <= height,
      block.text,
    );
  }
});

test("the four ants walk side by side across the team column, just under the clock line", () => {
  const spots = TEAM.map((_, k) => tallDayAntSpot(k, 12));
  spots.forEach((spot) => {
    assert.ok(spot.x > D.team.x && spot.x < D.team.x + D.team.w);
    assert.ok(spot.y > hourY(12) && spot.y < hourY(12) + 60);
  });
  assert.equal(new Set(spots.map((s) => s.x)).size, TEAM.length);
});

test("the summary is the film's four results in two rows", () => {
  assert.deepEqual(
    SUMMARY_ROWS.flat().map((item) => item.text),
    ["11 new customers", "2 meetings booked", "4 posts", "Website updated"],
  );
  assert.ok(
    summaryBox().y > tallDayAntSpot(0, DAY_END).y + 30,
    "summary hits the ants",
  );
});
