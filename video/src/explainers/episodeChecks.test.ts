import assert from "node:assert/strict";
import { type Beats, type EpisodeLine, timelineProblems } from "./episode.ts";

/**
 * Test helper, not a test: the rules every explainer keeps, from the
 * season spec and the pilot's rulings.
 */
export function assertEpisodeShape(o: {
  seconds: number;
  beats: Beats;
  lines: readonly EpisodeLine[];
  hook: {
    wordsAt: number;
    swarmFrom: number;
    stageFrom: number;
    stageTo: number;
  };
  avatarAt: number;
  /** The owner's click on the yes beat, when the episode has one. */
  click?: number;
  close: { dimFrom: number; urlAt: number };
  /** The last work moment on the stage before the end card. */
  doneAt: number;
}): void {
  const spoken = (id: string) => {
    const l = o.lines.find((x) => x.id === id);
    if (!l) throw new Error(`no line ${id}`);
    return l.speech;
  };
  assert.deepEqual(timelineProblems(o.beats, o.lines, o.seconds), []);
  assert.ok(o.seconds >= 33 && o.seconds <= 42, `film is ${o.seconds} s`);
  assert.ok(o.hook.wordsAt <= 0.2, "hook words late");
  assert.ok(o.hook.swarmFrom <= 0.1, "swarm late");
  const hookLine = o.lines.find((l) => l.beat === "hook");
  const meetLine = o.lines.find((l) => l.beat === "meet");
  if (!hookLine || !meetLine) throw new Error("hook and meet lines needed");
  assert.ok(
    o.hook.stageFrom >= hookLine.speech[1],
    "stage opens over the hook line",
  );
  assert.ok(
    o.hook.stageTo <= meetLine.speech[0] + 0.2,
    "stage still opening at the meet line",
  );
  assert.ok(
    o.avatarAt >= o.hook.stageTo,
    "employee appears before the stage is open",
  );
  const yes = o.lines.find((l) => l.beat === "yes");
  if (o.click !== undefined && yes) {
    assert.ok(
      o.click >= yes.speech[0] && o.click <= yes.speech[1] + 0.2,
      `click at ${o.click} is off the yes line ${yes.speech}`,
    );
  }
  assert.ok(
    o.close.dimFrom >= o.doneAt + 0.6,
    "end card before the work settles",
  );
  const [start, end] = spoken("e2");
  assert.ok(
    o.close.urlAt >= start - 0.3 && o.close.urlAt <= end,
    "address not shown while said",
  );
}
