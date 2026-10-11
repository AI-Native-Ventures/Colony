import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorAt } from "../launch/app/cursorPath.ts";
import { POSTS_CARD } from "../launch/wide/posts.ts";
import { EP05 } from "./ep05.ts";
import { APPROVE_BUTTON, approveCursorKeys } from "./ep05Card.ts";

const inside = (p: { x: number; y: number }, r: typeof APPROVE_BUTTON) =>
  p.x > r.x + 8 && p.x < r.x + r.w - 8 && p.y > r.y + 8 && p.y < r.y + r.h - 8;

test("the pointer is on Approve when it clicks, and stays there a moment", () => {
  const keys = approveCursorKeys(EP05);
  for (const t of [EP05.click - 0.1, EP05.click, EP05.click + 0.3]) {
    assert.ok(inside(cursorAt(keys, t), APPROVE_BUTTON), `at ${t}`);
  }
});

test("the Approve button sits inside the posts card, top right", () => {
  assert.ok(APPROVE_BUTTON.x > POSTS_CARD.x + POSTS_CARD.w / 2);
  assert.ok(
    APPROVE_BUTTON.x + APPROVE_BUTTON.w <= POSTS_CARD.x + POSTS_CARD.w - 40,
  );
  assert.ok(
    APPROVE_BUTTON.y >= POSTS_CARD.y + 30 &&
      APPROVE_BUTTON.y + APPROVE_BUTTON.h <= POSTS_CARD.y + 140,
  );
});
