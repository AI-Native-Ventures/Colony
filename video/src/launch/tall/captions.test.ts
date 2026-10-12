import assert from "node:assert/strict";
import { test } from "node:test";
import { SHOWN_LINES } from "../wide/film90Captions.ts";
import { captionChunks, chunkAt, ROW_CHARS } from "./captions.ts";

const textOf = (l: { text: string; caption?: string }) => l.caption ?? l.text;

test("every caption splits into chunks of at most two rows, each row short enough", () => {
  for (const line of SHOWN_LINES) {
    const chunks = captionChunks(textOf(line), ROW_CHARS);
    for (const c of chunks) {
      assert.ok(c.rows.length >= 1 && c.rows.length <= 2, line.id);
      for (const row of c.rows) {
        const oneWord = !row.includes(" ");
        assert.ok(oneWord || row.length <= ROW_CHARS, `${line.id}: "${row}"`);
      }
    }
  }
});

test("the chunks cover every word once, in order", () => {
  for (const line of SHOWN_LINES) {
    const words = textOf(line).split(/\s+/).filter(Boolean);
    const chunks = captionChunks(textOf(line), ROW_CHARS);
    assert.equal(chunks[0].from, 0);
    assert.equal(chunks[chunks.length - 1].to, words.length);
    for (let k = 1; k < chunks.length; k++) {
      assert.equal(chunks[k].from, chunks[k - 1].to);
    }
    assert.equal(
      chunks.flatMap((c) => c.rows).join(" "),
      words.join(" "),
      line.id,
    );
  }
});

test("Scout's long line needs more than one chunk", () => {
  const scout = SHOWN_LINES.find((l) => l.id === "s01");
  if (!scout) throw new Error("no s01");
  assert.ok(captionChunks(textOf(scout), ROW_CHARS).length >= 2);
});

test("the chunk on screen is the one holding the word being said", () => {
  const chunks = captionChunks(
    "one two three four five six seven eight nine ten eleven twelve",
    12,
  );
  assert.equal(chunkAt(chunks, 0), 0);
  assert.equal(chunkAt(chunks, 1), 0);
  const last = chunks.length - 1;
  assert.equal(chunkAt(chunks, 12), last);
  for (let n = 1; n <= 12; n++) {
    const k = chunkAt(chunks, n);
    assert.ok(n - 1 >= chunks[k].from && n - 1 < chunks[k].to);
  }
});

test("no chunk is a lone word when the line has four words or more", () => {
  for (const line of SHOWN_LINES) {
    const text = textOf(line);
    if (text.split(/\s+/).length < 4) continue;
    for (const c of captionChunks(text, ROW_CHARS)) {
      assert.ok(c.to - c.from >= 2, `${line.id}: lone "${c.rows.join(" ")}"`);
    }
  }
});

test("two rows are split evenly, not one long row and one stub", () => {
  const [chunk] = captionChunks("And there is never enough of you.", 26);
  assert.deepEqual(chunk.rows, ["And there is never", "enough of you."]);
});
