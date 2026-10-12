import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { CAN_CANT, CAN_CANT_TITLE } from "./canCantClaims.ts";
import { START_HERE } from "./startHereBeats.ts";
import { timeline } from "./timeline.ts";
import { VOICE_CUTS, voiceFile, voiceLead, voiceSeconds } from "./voiceCuts.ts";

const LINES = [
  ...START_HERE.flatMap((beat) => beat.lines),
  CAN_CANT_TITLE,
  ...CAN_CANT.flatMap((claim) => claim.lines),
];

test("every line of both videos has its voice file and its words inside its cut", () => {
  for (const line of LINES) {
    const cut = VOICE_CUTS[line.id];
    assert.ok(cut, `${line.id} has no voice`);
    assert.ok(
      cut.cut[0] <= cut.spoken[0] && cut.spoken[1] <= cut.cut[1],
      line.id,
    );
    assert.ok(voiceSeconds(line.id) > 0.5, line.id);
    assert.ok(voiceLead(line.id) >= 0, line.id);
    assert.ok(
      existsSync(
        new URL(`../../public/${voiceFile(line.id)}`, import.meta.url),
      ),
      `${line.id}: no file`,
    );
  }
  assert.equal(Object.keys(VOICE_CUTS).length, LINES.length);
});

test("an unknown line is an error, not silence", () => {
  assert.throws(() => voiceSeconds("no-such-line"), /no voice/);
});

test("with the real voice, every step stays on screen after its last word, and the whole runs about two minutes", () => {
  const tl = timeline(START_HERE, voiceSeconds);
  for (const beat of tl.beats) {
    const last = tl.lines.filter((line) => line.beat === beat.id).at(-1);
    assert.ok(
      last && beat.to - last.end >= 1.2 - 1e-9,
      `${beat.id} ends on its words`,
    );
  }
  assert.ok(tl.seconds > 100 && tl.seconds < 180, `${tl.seconds}`);
});
