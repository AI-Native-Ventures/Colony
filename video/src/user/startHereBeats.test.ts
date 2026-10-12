import assert from "node:assert/strict";
import { test } from "node:test";
import { copyProblems } from "./copy.ts";
import { checkManifest, SHOT_BOXES } from "./manifest.ts";
import { APP_SCALE } from "./stage.ts";
import { beatProblems, READ_ZOOM, START_HERE } from "./startHereBeats.ts";
import { fixtureManifest } from "./testManifest.ts";
import { estimateSeconds, timeline } from "./timeline.ts";

test("every move points at a captured shot and its boxes, in order", () => {
  for (const beat of START_HERE) {
    let last = -1;
    for (const move of beat.moves) {
      assert.ok(move.at >= 0 && move.at <= 1 && move.at > last, beat.id);
      last = move.at;
      const boxes: readonly string[] = SHOT_BOXES[move.shot];
      const named = [
        ...(move.focus === "window" ? [] : move.focus),
        ...(move.click ? [move.click] : []),
      ];
      for (const name of named)
        assert.ok(
          boxes.includes(name),
          `${beat.id}: ${move.shot} has no "${name}"`,
        );
    }
    assert.equal(beat.kind === "app", beat.moves.length > 0, beat.id);
  }
});

test("reading moves zoom so the app's 14 px text is at least 18 px on the frame", () => {
  assert.ok(14 * APP_SCALE * READ_ZOOM >= 18);
  for (const beat of START_HERE)
    for (const move of beat.moves)
      if (move.focus !== "window")
        assert.ok(move.zoom >= READ_ZOOM, `${beat.id} zooms ${move.zoom}`);
});

test("with every box mid-window, nothing lands outside the view or under the captions", () => {
  assert.deepEqual(
    beatProblems(START_HERE, checkManifest(fixtureManifest())),
    [],
  );
});

test("a zoomed target at the foot of the window is named: it would sit under the captions", () => {
  const manifest = checkManifest(
    fixtureManifest((shot) =>
      shot === "account"
        ? { x: 620, y: 884, w: 200, h: 14 }
        : { x: 620, y: 420, w: 200, h: 40 },
    ),
  );
  const problems = beatProblems(START_HERE, manifest);
  assert.ok(
    problems.some((p) => p.startsWith("account:")),
    problems.join("\n"),
  );
});

test("every line gets its voice and the video runs about two and a half minutes", () => {
  const texts = new Map(
    START_HERE.flatMap((beat) =>
      beat.lines.map((l) => [l.id, l.text] as const),
    ),
  );
  const tl = timeline(START_HERE, (id) => estimateSeconds(texts.get(id) ?? ""));
  let end = 0;
  for (const beat of tl.beats) {
    assert.ok(Math.abs(beat.from - end) < 1e-9, `${beat.id} leaves a gap`);
    end = beat.to;
  }
  for (const line of tl.lines) {
    const beat = tl.beats.find((b) => b.id === line.beat);
    assert.ok(beat && line.at >= beat.from && line.end <= beat.to, line.id);
  }
  assert.ok(tl.seconds > 130 && tl.seconds < 190, `${tl.seconds}`);
});

test("no line breaks the copy rules", () => {
  for (const beat of START_HERE)
    for (const line of beat.lines)
      assert.deepEqual(
        [...copyProblems(line.text), ...copyProblems(line.caption ?? "")],
        [],
        line.id,
      );
});
