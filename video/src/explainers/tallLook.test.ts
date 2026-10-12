import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BIG_CAPTIONS,
  captionChunks,
  FILM_CAPTIONS,
  ROW_CHARS,
} from "../launch/tall/captions.ts";
import {
  CAPTION_BOX,
  clearOfCovers,
  insideFeed,
  TALL_W,
} from "../launch/tall/frame.ts";
import {
  estimatedTitleSize,
  SLIM,
  slimTitleSize,
} from "../launch/tall/hero.ts";
import { LOOKS, OWNER, SCOUT_LOOK } from "../launch/wide/employees.ts";
import { EP01_LINES } from "./ep01.ts";
import { EP02_LINES, EP02_LOOK } from "./ep02.ts";
import { EP03_LINES } from "./ep03.ts";
import { EP04_LINES } from "./ep04.ts";
import { EP05_LINES } from "./ep05.ts";
import { EP06_LINES } from "./ep06.ts";
import { EP07_LINES } from "./ep07.ts";
import { EP08_LINES, EP08_LOOK } from "./ep08.ts";

const LINES = [
  ...EP01_LINES,
  ...EP02_LINES,
  ...EP03_LINES,
  ...EP04_LINES,
  ...EP05_LINES,
  ...EP06_LINES,
  ...EP07_LINES,
  ...EP08_LINES,
].filter((l) => l.captioned);

const textOf = (l: { text: string; caption?: string }) => l.caption ?? l.text;

test("the film keeps its captions", () => {
  assert.equal(FILM_CAPTIONS.size, 46);
  assert.equal(FILM_CAPTIONS.rowChars, ROW_CHARS);
  assert.deepEqual(FILM_CAPTIONS.box, CAPTION_BOX);
});

test("the explainers' captions are about 1.6 times the film's, in view and clear of the buttons", () => {
  const ratio = BIG_CAPTIONS.size / FILM_CAPTIONS.size;
  assert.ok(ratio >= 1.5 && ratio <= 1.7, `ratio ${ratio}`);
  assert.ok(clearOfCovers(BIG_CAPTIONS.box));
  assert.ok(insideFeed(BIG_CAPTIONS.box));
  assert.equal(BIG_CAPTIONS.box.x + BIG_CAPTIONS.box.w / 2, TALL_W / 2);
  assert.ok(BIG_CAPTIONS.box.h >= 2 * BIG_CAPTIONS.size * 1.15);
});

test("every explainer line chunks into two short rows at most, never a lone word", () => {
  for (const line of LINES) {
    const text = textOf(line);
    const many = text.split(/\s+/).length >= 4;
    for (const c of captionChunks(text, BIG_CAPTIONS.rowChars)) {
      assert.ok(c.rows.length <= 2, line.id);
      for (const row of c.rows) {
        const oneWord = !row.includes(" ");
        assert.ok(oneWord || row.length <= BIG_CAPTIONS.rowChars, row);
      }
      if (many) assert.ok(c.to - c.from >= 2, `${line.id}: "${c.rows}"`);
    }
  }
});

test("the slim header sits in view, clear of the buttons, and every title fits beside its avatar", () => {
  const box = {
    x: SLIM.avatar.x - SLIM.avatar.r,
    y: SLIM.avatar.y - SLIM.avatar.r,
    w: SLIM.right - (SLIM.avatar.x - SLIM.avatar.r),
    h: 2 * SLIM.avatar.r,
  };
  assert.ok(clearOfCovers(box));
  assert.ok(insideFeed(box));
  for (const look of [
    SCOUT_LOOK,
    EP02_LOOK,
    LOOKS.blue,
    LOOKS.amber,
    LOOKS.pink,
    LOOKS.green,
    OWNER,
    EP08_LOOK,
  ]) {
    const title = `${look.title[0]} ${look.title[1]}`;
    const size = slimTitleSize(estimatedTitleSize(title));
    assert.ok(size <= SLIM.titleSize, title);
    assert.ok(
      title.length * 0.56 * size <= SLIM.right - SLIM.titleLeft,
      `${title} at ${size}`,
    );
  }
});
