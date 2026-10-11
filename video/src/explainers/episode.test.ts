import assert from "node:assert/strict";
import { test } from "node:test";
import { type Beats, captionUntil, line, timelineProblems } from "./episode.ts";

const beats: Beats = {
  hook: { start: 0, end: 3 },
  meet: { start: 3, end: 8 },
  work: { start: 8, end: 28 },
  yes: { start: 28, end: 32 },
  end: { start: 32, end: 36 },
};
const good = [
  line(
    "ep",
    "h1",
    "hook",
    "When did you last post?",
    [0, 1.7],
    [0.1, 1.6],
    0.3,
  ),
  line(
    "ep",
    "m1",
    "meet",
    "This one makes your posts.",
    [2, 4],
    [2.1, 3.9],
    4.0,
  ),
  line(
    "ep",
    "y1",
    "yes",
    "You check them, and say yes.",
    [5, 7],
    [5.1, 6.9],
    28.5,
  ),
];

test("a sound timeline has no problems", () => {
  assert.deepEqual(timelineProblems(beats, good, 36), []);
});

test("a line spoken outside its beat is a problem", () => {
  const late = [
    ...good.slice(0, 2),
    line("ep", "y1", "yes", "You say yes.", [5, 7], [5.1, 6.9], 31),
  ];
  assert.match(timelineProblems(beats, late, 36).join("\n"), /y1.*outside yes/);
});

test("overlapping lines are a problem", () => {
  const clash = [
    good[0],
    line(
      "ep",
      "m1",
      "meet",
      "This one makes your posts.",
      [2, 4],
      [2.1, 3.9],
      1.2,
    ),
    good[2],
  ];
  assert.match(timelineProblems(beats, clash, 36).join("\n"), /m1/);
});

test("a hook voiced after the first second is a problem", () => {
  const slow = [
    line(
      "ep",
      "h1",
      "hook",
      "When did you last post?",
      [0, 1.7],
      [0.1, 1.6],
      1.2,
    ),
    ...good.slice(1),
  ];
  assert.match(timelineProblems(beats, slow, 36).join("\n"), /hook/);
});

test("beats that leave a gap or overrun the film are a problem", () => {
  const gap = { ...beats, meet: { start: 3.5, end: 8 } };
  assert.match(timelineProblems(gap, good, 36).join("\n"), /meet starts/);
  assert.match(timelineProblems(beats, good, 34).join("\n"), /end/);
});

test("a caption too short to read is a problem", () => {
  const rushed = [
    ...good.slice(0, 2),
    line(
      "ep",
      "y1",
      "yes",
      "You check every single one of them and then you say yes.",
      [5, 6],
      [5.0, 5.6],
      28.5,
    ),
  ];
  assert.match(timelineProblems(beats, rushed, 36).join("\n"), /y1.*read/);
});

test("a fast line is fine when its caption holds until the next line", () => {
  const fast = [
    good[0],
    line(
      "ep",
      "m1",
      "meet",
      "This one makes your posts for you, too.",
      [2, 4],
      [2.1, 3.9],
      4.0,
    ),
    good[2],
  ];
  assert.deepEqual(timelineProblems(beats, fast, 36), []);
  assert.equal(captionUntil(fast, 1), 4.0 + 1.8 + 1.8);
  assert.equal(captionUntil(fast, 2), 28.5 + 1.8 + 0.7);
});

test("a caption holds only until just before the next line", () => {
  const close = [
    good[0],
    line(
      "ep",
      "m1",
      "meet",
      "This one makes your posts.",
      [2, 4],
      [2.1, 3.9],
      4.0,
    ),
    line("ep", "m2", "meet", "Every week.", [5, 6], [5.1, 5.8], 6.3),
    good[2],
  ];
  assert.equal(captionUntil(close, 1), 6.25);
});

test("a line shown on screen as big type has no caption to read", () => {
  const shown = [
    ...good.slice(0, 2),
    line(
      "ep",
      "e1",
      "end",
      "Colony. AI employees for your business.",
      [8, 9],
      [8.0, 8.4],
      33.0,
      false,
    ),
  ];
  assert.deepEqual(timelineProblems(beats, shown, 36), []);
  assert.equal(shown[2].captioned, false);
});
