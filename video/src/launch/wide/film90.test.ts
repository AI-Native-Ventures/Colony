import assert from "node:assert/strict";
import { test } from "node:test";
import { foundCount } from "./beat.ts";
import { EMAIL } from "./email.ts";
import { type EmployeeId, TEAM } from "./employees.ts";
import {
  ACT_ORDER,
  ACTS,
  AMBER90,
  BEAT_DONE,
  BLUE90,
  CLICK90,
  FILM90_SECONDS,
  GREEN90,
  LINES,
  PANS,
  PINK90,
  panelX,
  panX,
  RIVERS90,
  TIMING90,
} from "./film90.ts";
import { postLandsAt } from "./posts.ts";
import { riverAnts } from "./riverAnts.ts";
import { typewriterEnd } from "./typewriter.ts";

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

test("the camera holds still on each employee while they speak", () => {
  for (const line of LINES) {
    if (!(TEAM as readonly string[]).includes(line.act)) continue;
    const x = panelX(line.act as EmployeeId);
    for (const t of [line.speech[0], (line.speech[0] + line.speech[1]) / 2]) {
      assert.equal(panX(t), x, `${line.id} at ${t}`);
    }
  }
});

test("the camera only ever moves forward", () => {
  let prev = panX(24);
  for (let t = 24; t <= 56; t += 1 / 30) {
    assert.ok(panX(t) >= prev, `moved back at ${t}`);
    prev = panX(t);
  }
  assert.equal(panX(56), panelX("green"));
});

test("each glide ends before the next employee appears", () => {
  for (const pan of PANS) {
    assert.ok(pan.end <= TIMING90[pan.to].avatarAt, `${pan.to} pops mid glide`);
  }
});

test("the camera stays on an employee until its work is done", () => {
  for (const pan of PANS) {
    const before = TEAM[TEAM.indexOf(pan.to) - 1];
    assert.ok(pan.start >= BEAT_DONE[before], `left ${before} too soon`);
  }
});

test("each employee's river lands as its avatar appears", () => {
  for (const id of TEAM) {
    const river = RIVERS90[id];
    assert.equal(river.landAt, TIMING90[id].avatarAt);
    for (const ant of riverAnts(river)) {
      const lands = ant.release + ant.duration;
      assert.ok(lands >= river.landAt - 0.5, `${id} ant lands at ${lands}`);
      assert.ok(lands <= river.landAt + 0.45, `${id} ant lands at ${lands}`);
    }
  }
});

test("the email is typed before the drafts count up", () => {
  const end = typewriterEnd(EMAIL.lines, {
    start: AMBER90.typeFrom,
    cps: AMBER90.typeCps,
    returnSeconds: AMBER90.returnSeconds,
  });
  assert.ok(AMBER90.typeFrom >= AMBER90.cardIn + 0.5, "types before the card");
  assert.ok(end + 0.1 <= AMBER90.countRushFrom, `typing ends at ${end}`);
});

test("all three posts land before '3 ready'", () => {
  assert.ok(postLandsAt(2, PINK90) + 0.2 <= PINK90.readyAt);
});

test("the website is repainted before 'Updated'", () => {
  assert.ok(GREEN90.paintFrom + GREEN90.paintDuration <= GREEN90.chipAt);
});
