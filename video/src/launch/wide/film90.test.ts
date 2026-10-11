import assert from "node:assert/strict";
import { test } from "node:test";
import { foundCount } from "./beat.ts";
import {
  ACT_ORDER,
  ACTS,
  BEAT_DONE,
  BLUE90,
  CLICK90,
  FILM90_SECONDS,
  LINES,
} from "./film90.ts";

test("acts run back to back from 0 to 90 s", () => {
  assert.equal(ACTS[ACT_ORDER[0]].start, 0);
  for (let i = 1; i < ACT_ORDER.length; i++) {
    assert.equal(
      ACTS[ACT_ORDER[i]].start,
      ACTS[ACT_ORDER[i - 1]].end,
      `${ACT_ORDER[i]} does not start where ${ACT_ORDER[i - 1]} ends`,
    );
  }
  assert.equal(ACTS[ACT_ORDER[ACT_ORDER.length - 1]].end, FILM90_SECONDS);
});

test("every line is spoken inside its own act", () => {
  for (const line of LINES) {
    const act = ACTS[line.act];
    assert.ok(
      act.start <= line.speech[0] && line.speech[1] <= act.end,
      `${line.id} spills out of ${line.act}`,
    );
  }
});

test("lines never overlap", () => {
  const sorted = [...LINES].sort((a, b) => a.speech[0] - b.speech[0]);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i].speech[0] >= sorted[i - 1].speech[1] + 0.2,
      `${sorted[i].id} crowds ${sorted[i - 1].id}`,
    );
  }
});

test("each cut file starts before its words and the words fit the cut", () => {
  for (const line of LINES) {
    assert.ok(line.at <= line.speech[0], `${line.id} file starts late`);
    const cutLength = line.cut[1] - line.cut[0];
    assert.ok(
      line.speech[1] - line.at <= cutLength + 1e-6,
      `${line.id} speech runs past its cut`,
    );
  }
});

test("the Approve click lands on 'your yes'", () => {
  const yes = LINES.find((l) => l.text.includes("your yes"));
  assert.ok(yes);
  assert.ok(CLICK90 >= yes.speech[0] && CLICK90 <= yes.speech[1]);
});

test("each employee finishes its work before the next one speaks", () => {
  const next = {
    blue: "amber",
    amber: "pink",
    pink: "green",
    green: "yes",
  } as const;
  for (const [beat, after] of Object.entries(next)) {
    const firstLine = LINES.filter((l) => l.act === after).sort(
      (a, b) => a.speech[0] - b.speech[0],
    )[0];
    assert.ok(
      BEAT_DONE[beat as keyof typeof BEAT_DONE] <= firstLine.speech[0],
      `${beat} still working when ${after} speaks`,
    );
  }
});

test("the film's blue beat has found all 20 before amber speaks", () => {
  assert.equal(foundCount(ACTS.amber.start, BLUE90), 20);
  assert.equal(foundCount(ACTS.blue.start, BLUE90), 0);
});
