import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorAt } from "../app/cursorPath.ts";
import { TEAM } from "./employees.ts";
import {
  CONTINUE_BUTTON,
  HOW,
  howCursorKeys,
  READ_BUTTON,
  SUMMARY_TEXT,
  summaryTypedAt,
  TEAM_ROWS,
  teamRowAt,
} from "./how.ts";

function inside(p: { x: number; y: number }, r: typeof READ_BUTTON): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

test("the pointer rests on Read website when it is pressed", () => {
  for (const t of [HOW.readClick - 0.1, HOW.readClick]) {
    assert.ok(inside(cursorAt(howCursorKeys(HOW), t), READ_BUTTON), `at ${t}`);
  }
});

test("the pointer rests on Continue when it is pressed", () => {
  for (const t of [HOW.continueClick - 0.1, HOW.continueClick]) {
    assert.ok(
      inside(cursorAt(howCursorKeys(HOW), t), CONTINUE_BUTTON),
      `at ${t}`,
    );
  }
});

test("the website is pasted before Read website is pressed", () => {
  assert.ok(HOW.pasteAt + 0.4 <= HOW.readClick);
});

test("the summary is written from the website before Continue is pressed", () => {
  assert.ok(summaryTypedAt(HOW) + 0.2 <= HOW.continueClick);
  assert.ok(SUMMARY_TEXT.length <= 90, "summary too long for the card");
});

test("the team appears in the order the film meets them", () => {
  assert.deepEqual(
    TEAM_ROWS.map((row) => row.who),
    [...TEAM],
  );
  for (let i = 1; i < TEAM_ROWS.length; i++) {
    assert.ok(teamRowAt(i, HOW) > teamRowAt(i - 1, HOW));
  }
  assert.ok(teamRowAt(0, HOW) > HOW.continueClick);
});
