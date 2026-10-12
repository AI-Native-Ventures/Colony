import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GETTING_STARTED,
  LOOKS,
  OWNER,
  SCOUT_LOOK,
} from "../wide/employees.ts";
import { HERO } from "./hero.ts";
import { HERO_BOX } from "./frame.ts";
import { estimatedTitleSize, heroTitle } from "./hero.ts";

const LOOKS_USED = [
  GETTING_STARTED,
  SCOUT_LOOK,
  LOOKS.blue,
  LOOKS.amber,
  LOOKS.pink,
  LOOKS.green,
  OWNER,
];

test("every employee title is one line", () => {
  for (const look of LOOKS_USED) {
    const title = heroTitle(look);
    assert.ok(title.length > 0 && !title.includes("\n"), title);
  }
});

test("a title that is too wide shrinks, but stays big", () => {
  for (const look of LOOKS_USED) {
    const size = estimatedTitleSize(heroTitle(look));
    assert.ok(
      size <= HERO.titleSize && size >= 72,
      `${heroTitle(look)}: ${size}`,
    );
  }
  assert.ok(estimatedTitleSize("Keeps your site fresh.") < HERO.titleSize);
});

test("the row, the title and the subline stay inside the hero box", () => {
  const bottom = HERO.sublineTop + 2 * HERO.sublineSize * 1.3;
  assert.ok(HERO.avatar.y - HERO.avatar.r >= HERO_BOX.y);
  assert.ok(bottom <= HERO_BOX.y + HERO_BOX.h, `${bottom}`);
  assert.ok(HERO.titleTop + HERO.titleSize <= HERO.sublineTop);
  assert.equal(HERO.titleWidth, HERO_BOX.w);
});
