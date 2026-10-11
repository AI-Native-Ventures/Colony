import assert from "node:assert/strict";
import { test } from "node:test";
import { foundCount } from "./beat.ts";
import { HOW } from "./how.ts";
import { SCOUT_TASKS, taskLandsAt } from "./scout.ts";
import { INTRO, TOWER_WORDS, TRADE_WORDS } from "./intro.ts";
import { EMAIL } from "./email.ts";
import { TEAM } from "./employees.ts";
import {
  ACT_ORDER,
  ACTS,
  AMBER90,
  BEAT_DONE,
  BLUE90,
  CLICK90,
  CLOSE90,
  DAY90,
  FILM90_SECONDS,
  GREEN90,
  ACT_PANEL,
  LINES,
  PANEL_DONE,
  PANEL_ORDER,
  PANEL_START,
  PANS,
  PINK90,
  panelX,
  SCOUT90,
  panX,
  RIVERS90,
  TIMING90,
} from "./film90.ts";
import { postLandsAt } from "./posts.ts";
import { teamRowAt } from "./how.ts";
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

test("the camera holds still on each panel while its lines are spoken", () => {
  for (const line of LINES) {
    const panel = ACT_PANEL[line.act];
    if (!panel) continue;
    for (const t of [line.speech[0], (line.speech[0] + line.speech[1]) / 2]) {
      assert.equal(panX(t), panelX(panel), `${line.id} at ${t}`);
    }
  }
});

test("the camera only ever moves forward", () => {
  let prev = panX(30);
  for (let t = 30; t <= 100; t += 1 / 30) {
    assert.ok(panX(t) >= prev, `moved back at ${t}`);
    prev = panX(t);
  }
  assert.equal(panX(100), panelX("day"));
});

test("each glide ends before the next panel's first thing appears", () => {
  for (const pan of PANS) {
    assert.ok(pan.end <= PANEL_START[pan.to], `${pan.to} starts mid glide`);
  }
});

test("the camera stays on a panel until its work is done", () => {
  for (const pan of PANS) {
    const before = PANEL_ORDER[PANEL_ORDER.indexOf(pan.to) - 1];
    assert.ok(pan.start >= PANEL_DONE[before], `left ${before} too soon`);
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

function spoken(id: string): readonly [number, number] {
  const found = LINES.find((l) => l.id === id);
  assert.ok(found, `no line ${id}`);
  return found.speech;
}

test("trades show while 'the work you love' is said, or just after", () => {
  assert.ok(TRADE_WORDS[0].at >= spoken("n01")[0]);
  assert.ok(TRADE_WORDS[TRADE_WORDS.length - 1].at <= spoken("n01")[1] + 0.7);
});

test("the jobs pile up while 'everything else' is said", () => {
  assert.ok(TOWER_WORDS[0].at >= spoken("n02")[0] + 0.8);
  assert.ok(TOWER_WORDS[3].at <= spoken("n02")[1] + 0.2);
});

test("the logo lands just before 'Introducing: Colony.'", () => {
  const [start] = spoken("n04");
  assert.ok(INTRO.logoIn <= start && start <= INTRO.logoIn + 0.6);
});

test("the tagline appears while Colony is explained", () => {
  const [start, end] = spoken("n05");
  assert.ok(INTRO.tagline >= start && INTRO.tagline <= end);
});

test("'AI employee' is defined on screen as it is said", () => {
  const [start] = spoken("n06");
  assert.ok(INTRO.defineFrom <= start && start <= INTRO.defineFrom + 0.5);
  assert.ok(INTRO.brightFrom >= spoken("n06")[1] + 0.8, "bright too soon");
});

test("the bright app world is open before 'Paste your website'", () => {
  assert.ok(INTRO.brightTo <= spoken("n07")[0]);
  const [start, end] = spoken("n07");
  assert.ok(HOW.pasteAt >= start && HOW.pasteAt <= end);
});

test("the whole team is in before Scout is introduced", () => {
  assert.ok(teamRowAt(TEAM.length - 1, HOW) + 0.3 <= spoken("s01")[0]);
});

test("Scout hands out every task before saying it checks the work", () => {
  const [start, end] = spoken("s01");
  assert.ok(taskLandsAt(SCOUT_TASKS.length - 1, SCOUT90) <= SCOUT90.checkAt);
  assert.ok(SCOUT90.checkAt >= start && SCOUT90.checkAt <= end);
  assert.ok(SCOUT90.taskFrom >= SCOUT90.cardIn + 0.5, "tasks before the card");
});

test("the sales employee emails while 'it emails each of them' is said", () => {
  const [, end] = spoken("a01");
  assert.ok(AMBER90.typeFrom <= end, "typing starts after the line");
});

test("the call starts as 'and calls to book a meeting' is said", () => {
  const [start] = spoken("a02");
  assert.ok(AMBER90.callIn <= start && start <= AMBER90.callIn + 0.6);
  assert.ok(AMBER90.callIn >= AMBER90.countRushFrom + AMBER90.countRush + 0.3);
  assert.ok(AMBER90.connectAt < AMBER90.bubble1At);
  assert.ok(AMBER90.bubble1At < AMBER90.bubble2At);
  assert.ok(AMBER90.bubble2At < AMBER90.bookedAt);
});

test("the logo is back before 'Colony.' and the address shows as it is said", () => {
  assert.ok(CLOSE90.logoIn <= spoken("c01")[0]);
  const [start, end] = spoken("c02");
  assert.ok(CLOSE90.urlAt >= start && CLOSE90.urlAt <= end);
  assert.ok(end + 2 <= FILM90_SECONDS, "address not held long enough");
});

test("the close starts after the day's summary has been seen", () => {
  assert.ok(CLOSE90.dimFrom >= DAY90.summaryAt + 1.5);
});
