import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorAt } from "../app/cursorPath.ts";
import { bezier } from "../swarm.ts";
import { CLICK90, LINES, YES90 } from "./film90.ts";
import {
  APPROVE_BUTTON,
  approvedAt,
  YES_ROWS,
  yesCarryPath,
  yesCursorKeys,
  yesLandsAt,
  yesOwnerSpot,
} from "./yes.ts";

test("there is one card per employee", () => {
  assert.deepEqual(
    YES_ROWS.map((row) => row.who),
    ["blue", "amber", "pink", "green"],
  );
});

test("each carrier walks in from the left edge to its own row", () => {
  YES_ROWS.forEach((_, i) => {
    const path = yesCarryPath(i);
    assert.ok(path[0].x < 0, "starts on screen");
    assert.deepEqual(path[3], yesOwnerSpot(i));
  });
});

test("carriers stay clear of the subtitles at the bottom", () => {
  YES_ROWS.forEach((_, i) => {
    const [p0, p1, p2, p3] = yesCarryPath(i);
    for (let k = 0; k <= 200; k++) {
      const p = bezier(p0, p1, p2, p3, k / 200);
      assert.ok(
        !(p.x >= 400 && p.x <= 1520 && p.y >= 900),
        `row ${i} carrier at ${p.x.toFixed(0)},${p.y.toFixed(0)}`,
      );
    }
  });
});

test("all four cards arrive before 'Nothing goes out without your yes'", () => {
  const line = LINES.find((l) => l.text.includes("your yes"));
  assert.ok(line);
  assert.ok(yesLandsAt(YES_ROWS.length - 1, YES90) <= line.speech[0]);
});

test("the cursor rests on Approve before the click", () => {
  for (const t of [CLICK90 - 0.12, CLICK90]) {
    const p = cursorAt(yesCursorKeys(YES90), t);
    const b = APPROVE_BUTTON;
    assert.ok(
      p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h,
      `cursor at ${p.x},${p.y} at ${t}`,
    );
  }
});

test("rows are approved one after another, right after the click", () => {
  assert.ok(approvedAt(0, YES90) > CLICK90);
  assert.ok(approvedAt(0, YES90) < CLICK90 + 0.3);
  for (let i = 1; i < YES_ROWS.length; i++) {
    assert.ok(approvedAt(i, YES90) > approvedAt(i - 1, YES90));
  }
});

test("carriers and their tags pass under the owner's title and subline", () => {
  YES_ROWS.forEach((_, i) => {
    const [p0, p1, p2, p3] = yesCarryPath(i);
    for (let k = 0; k <= 200; k++) {
      const p = bezier(p0, p1, p2, p3, k / 200);
      // The subline ends at y 740; a carried tag rides 72 px above its ant.
      if (p.x >= 120 && p.x <= 760) {
        assert.ok(
          p.y >= 815,
          `row ${i} carrier at ${p.x.toFixed(0)},${p.y.toFixed(0)}`,
        );
      }
    }
  });
});
