# Colony Explainer 05 (bakery posts pilot) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This run is native inline: the owner forbids subagents.

**Goal:** Build and ship the pilot explainer, episode 5 "Makes your posts" for Rise Bakery: a 16:9, ~36 s motion graphics video in the launch film's world, plus the shared explainer kit the other seven episodes will reuse.

**Architecture:** A small kit in `video/src/explainers/` (timeline types and checks, a shell that draws the light world, the bright stage, captions, end card and audio) reused by each episode. Episode 5 adds its timeline (`ep05.ts`), a hook scene (ants build a croissant), and a posts card that reuses the launch film's post geometry, worker ants and employee hero, with three bakery posts drawn in code from Pinterest bakery references.

**Tech Stack:** Remotion 4.0.522, React 19, TypeScript run by Node 24's test runner (type stripping), Gemini TTS (Aoede) via `zsh -ic`, ffmpeg, gstack `$B` headless browser for references.

**Spec:** `docs/superpowers/specs/2026-10-11-colony-explainers-s1-design.html`

## Global Constraints

- 1920 by 1080, 30 fps; target 33 to 42 seconds.
- Motion graphics drawn in code only: no AI video, no mascot, no photos.
- Voice: Gemini `gemini-3.8-flash-tts`, voice `Aoede`, read through `zsh -ic` with header `x-goog-api-key`; never print the key.
- Copy: no em dashes; the banned-word rule from `src/launch/film.test.ts` applies ("AI agents" allowed, bare "agent" not).
- Never a whole app window; body text at least 28 px; nothing new appears during a camera or stage move; no dark frames.
- The customer's work (the three posts) is drawn in the bakery style taken from Pinterest bakery references; Colony's own UI stays in Inter.
- End card: "Colony. AI employees for your business." and "Early access is open at colony.global", with no drop shadow under the logo (owner feedback, cut 4).
- Commit with `git commit -s`; push only `claude/colony-explainers-s1` with an explicit refspec as `nocodeafrica`.

## Review Focus

1. The first frame is already the hook: words and swarm visible at frame 0 to 10, voice by 0.5 s (a social viewer scrolls past a slow start).
2. Captions never cover the posts card or its ants (card bottom must stay above y 940).
3. The carried posts at 0.27 scale stay readable as posts, not smudges (check stills mid-carry).
4. The end card has no shadow or fuzz around the logo at any frame (same bug the owner flagged in the launch film intro).
5. The voice line "colony dot global" is captioned as "colony.global" and the pill shows while it is said.

---

### Task 1: Bakery references and the Rise Bakery brand kit

**Files:**
- Create: `video/src/explainers/rise.ts`
- Modify: `video/src/launch/fonts.ts` (add the bakery faces)
- Test: `video/src/explainers/rise.test.ts`

**Interfaces:**
- Produces: `RISE` (name, place, handle), `RISE_COLORS` (cream, crust, cocoa, berry, butter, ink), `RISE_POSTS: { id: "sourdough" | "market" | "croissant"; when: string }[]`; fonts `SERIF` (Fraunces) and `SCRIPT` (Sacramento) exported from `fonts.ts` and awaited by `fontsReady`.

- [ ] **Step 1:** Look at Pinterest bakery Instagram posts logged out with `$B` (recipe in memory `pinterest-design-references`): queries `bakery instagram post design`, `bakery social media post`, `sourdough bakery instagram`. Build a contact sheet, pick 3 references (one per post idea), note palette, type, layout. Do not save or publish pins.
- [ ] **Step 2: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { RISE, RISE_POSTS } from "./rise.ts";

test("Rise Bakery posts go out this week, one per idea, in order", () => {
  assert.deepEqual(
    RISE_POSTS.map((p) => p.id),
    ["sourdough", "market", "croissant"],
  );
  assert.deepEqual(
    RISE_POSTS.map((p) => p.when),
    ["Tue 7:00", "Thu 12:30", "Sat 6:30"],
  );
  assert.equal(RISE.name, "Rise Bakery");
});
```

- [ ] **Step 3:** Run `node --test src/explainers/rise.test.ts`; expect FAIL (module missing).
- [ ] **Step 4:** Write `rise.ts` with the values above and colours sampled from the chosen references; add Fraunces 600/700 and Sacramento 400 to `fonts.ts` and to `fontsReady`.
- [ ] **Step 5:** Run the test; expect PASS. Commit `video(explainers): Rise Bakery brand kit from Pinterest bakery references`.

### Task 2: Timeline kit with checks

**Files:**
- Create: `video/src/explainers/episode.ts`, `video/src/explainers/episode.test.ts`
- Create: `video/src/launch/banned.ts` (move `bannedWord` out of `film.test.ts`), modify `video/src/launch/film.test.ts` to import it
- Create: `video/src/explainers/copy.test.ts` (banned words across `src/explainers`)

**Interfaces:**
- Produces:

```ts
export type BeatId = "hook" | "meet" | "work" | "yes" | "end";
export const BEAT_ORDER: readonly BeatId[];
export type Span = { start: number; end: number };
export type Beats = Record<BeatId, Span>;
export type EpisodeLine = BeatLine & { beat: BeatId; cut: readonly [number, number] };
export function line(episode: string, id: string, beat: BeatId, text: string,
  cut: readonly [number, number], spoken: readonly [number, number],
  startsAt: number, caption?: string): EpisodeLine;
export function timelineProblems(beats: Beats, lines: readonly EpisodeLine[], seconds: number): string[];
export function bannedWord(src: string): string | undefined; // in src/launch/banned.ts
```

- [ ] **Step 1: Write the failing tests** (`episode.test.ts`)

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Beats, line, timelineProblems } from "./episode.ts";

const beats: Beats = {
  hook: { start: 0, end: 3 },
  meet: { start: 3, end: 8 },
  work: { start: 8, end: 28 },
  yes: { start: 28, end: 32 },
  end: { start: 32, end: 36 },
};
const good = [
  line("ep", "h1", "hook", "When did you last post?", [0, 1.6], [0.1, 1.5], 0.3),
  line("ep", "m1", "meet", "This one makes your posts.", [2, 4], [2.1, 3.9], 4.0),
  line("ep", "y1", "yes", "You check them, and say yes.", [5, 7], [5.1, 6.9], 28.5),
];

test("a sound timeline has no problems", () => {
  assert.deepEqual(timelineProblems(beats, good, 36), []);
});

test("a line spoken outside its beat is a problem", () => {
  const late = [...good.slice(0, 2), line("ep", "y1", "yes", "You say yes.", [5, 7], [5.1, 6.9], 31)];
  assert.match(timelineProblems(beats, late, 36).join("\n"), /y1.*outside yes/);
});

test("overlapping lines are a problem", () => {
  const clash = [good[0], line("ep", "m1", "meet", "This one makes your posts.", [2, 4], [2.1, 3.9], 1.2), good[2]];
  assert.match(timelineProblems(beats, clash, 36).join("\n"), /m1/);
});

test("a hook voiced after the first second is a problem", () => {
  const slow = [line("ep", "h1", "hook", "When did you last post?", [0, 1.6], [0.1, 1.5], 1.2), ...good.slice(1)];
  assert.match(timelineProblems(beats, slow, 36).join("\n"), /hook/);
});

test("beats that leave a gap or overrun the film are a problem", () => {
  const gap = { ...beats, meet: { start: 3.5, end: 8 } };
  assert.match(timelineProblems(gap, good, 36).join("\n"), /meet starts/);
  assert.match(timelineProblems(beats, good, 34).join("\n"), /end/);
});

test("a caption too short to read is a problem", () => {
  const rushed = [...good.slice(0, 2), line("ep", "y1", "yes", "You check every single one of them and then you say yes.", [5, 6], [5.0, 5.6], 28.5)];
  assert.match(timelineProblems(beats, rushed, 36).join("\n"), /y1.*read/);
});
```

- [ ] **Step 2:** Run `node --test src/explainers/episode.test.ts`; expect FAIL (module missing).
- [ ] **Step 3: Implement `episode.ts`**

```ts
import type { BeatLine } from "../launch/wide/beat.ts";

export type BeatId = "hook" | "meet" | "work" | "yes" | "end";
export const BEAT_ORDER: readonly BeatId[] = ["hook", "meet", "work", "yes", "end"];
export type Span = { start: number; end: number };
export type Beats = Record<BeatId, Span>;
export type EpisodeLine = BeatLine & { beat: BeatId; cut: readonly [number, number] };

/** A line cut from one Aoede read: `cut` and `spoken` are seconds in the read, `startsAt` the film second the words start. */
export function line(episode: string, id: string, beat: BeatId, text: string,
  cut: readonly [number, number], spoken: readonly [number, number],
  startsAt: number, caption?: string): EpisodeLine {
  const lead = spoken[0] - cut[0];
  return { id, beat, text, caption, cut,
    file: `explainers/${episode}-${id}.mp3`,
    at: startsAt - lead,
    speech: [startsAt, startsAt + (spoken[1] - spoken[0])] };
}

/** Everything wrong with an episode's timeline, in plain words; empty when sound. */
export function timelineProblems(beats: Beats, lines: readonly EpisodeLine[], seconds: number): string[] {
  const out: string[] = [];
  if (beats.hook.start !== 0) out.push("hook must start at 0");
  for (let i = 1; i < BEAT_ORDER.length; i++) {
    const prev = beats[BEAT_ORDER[i - 1]];
    const cur = beats[BEAT_ORDER[i]];
    if (Math.abs(cur.start - prev.end) > 1e-6) out.push(`${BEAT_ORDER[i]} starts at ${cur.start}, not where ${BEAT_ORDER[i - 1]} ends (${prev.end})`);
  }
  if (Math.abs(beats.end.end - seconds) > 1e-6) out.push(`end beat stops at ${beats.end.end}, film is ${seconds}`);
  const hook = lines.find((l) => l.beat === "hook");
  if (!hook || hook.speech[0] > 1.0) out.push("hook must be voiced within the first second");
  lines.forEach((l, i) => {
    const span = beats[l.beat];
    if (l.speech[0] < span.start || l.speech[1] > span.end) out.push(`${l.id} is spoken outside ${l.beat}`);
    if (l.at < 0) out.push(`${l.id} file starts before the film`);
    const words = (l.caption ?? l.text).split(/\s+/).length;
    if (l.speech[1] - l.speech[0] + 0.7 < words / 3 + 0.5) out.push(`${l.id} is up too briefly to read`);
    const next = lines[i + 1];
    if (next && next.speech[0] < l.speech[1] + 0.15) out.push(`${l.id} runs into ${next.id}`);
  });
  return out;
}
```

- [ ] **Step 4:** Move `bannedWord` into `src/launch/banned.ts` (export), import it in `film.test.ts`; add `src/explainers/copy.test.ts` that scans `src/explainers` (non-test `.ts`/`.tsx`) with `bannedWord` and asserts none, plus asserts no `—` in those files.
- [ ] **Step 5:** Run `node --test src/launch/*.test.ts src/launch/wide/*.test.ts src/explainers/*.test.ts`; expect all PASS. Commit `video(explainers): episode timeline kit with checks`.

### Task 3: Voice for episode 5

**Files:**
- Create: `video/public/explainers/ep05-{h1,m1,w1,w2,w3,y1,e1,e2}.mp3`
- Modify: `video/public/launch/SOURCES.md` (new section "Explainer voices")

Script (one read, these exact lines):

```
When did you last post? Be honest.
Colony gives your business AI employees. This one makes your posts.
Tell it what's happening this week: new sourdough, and the Saturday market.
It writes the words and makes the pictures, in your bakery's style.
Then it picks the best times to post.
You check them, and say yes.
Colony. AI employees for your business.
Early access is open at colony dot global.
```

- [ ] **Step 1:** Write the script to `scratchpad/audio/ep05/read.txt`; run `zsh -ic "$P/gemini-tts.sh gemini-3.8-flash-tts Aoede read.txt read.pcm"`; convert to wav; `loudnorm=I=-16:TP=-1.5:LRA=11` at 48 kHz.
- [ ] **Step 2:** `silencedetect=noise=-40dB:d=0.18`; map each sentence to `cut` (pause midpoints) and `spoken` (sound edges); extract each with 40 ms fade in, 60 ms fade out, mp3 192k mono 48 kHz.
- [ ] **Step 3:** Transcribe each clip (16 kHz) with `gemini-2.5-flash` (5 per minute); every clip must match its line (allow "colony.global" for "colony dot global").
- [ ] **Step 4:** Record cut points in SOURCES.md. Commit `video(explainers): Aoede voice for episode 5`.

### Task 4: Episode 5 timeline

**Files:**
- Create: `video/src/explainers/ep05.ts`, `video/src/explainers/ep05.test.ts`

**Interfaces:**
- Consumes: `line`, `Beats`, `timelineProblems` (Task 2); measured cuts (Task 3); `RISE_POSTS` (Task 1).
- Produces: `EP05_SECONDS`, `EP05_REQUEST` (the owner's typed line), `EP05_BEATS: Beats`, `EP05_LINES: EpisodeLine[]`, `EP05: { hookWordsAt, hookHonestAt, swarmFrom, swarmBuilt, stageFrom, stageTo, avatarAt, headlineAt, sublineAt, focusFrom, cardIn, requestFrom, requestCps, carryFrom, carryEvery, carryDuration, timesAt, readyAt, cursorFrom, click, scheduledAt, closeFrom, closeDark, logoIn, name, tagline, earlyAt, urlAt }`.

- [ ] **Step 1: Write the failing test** (`ep05.test.ts`)

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { timelineProblems } from "./episode.ts";
import { POSTS_CARD } from "../launch/wide/posts.ts";
import { EP05, EP05_BEATS, EP05_LINES, EP05_REQUEST, EP05_SECONDS } from "./ep05.ts";
import { RISE_POSTS } from "./rise.ts";

const spoken = (id: string) => {
  const l = EP05_LINES.find((x) => x.id === id);
  if (!l) throw new Error(`no line ${id}`);
  return l.speech;
};
const landsAt = (i: number) => EP05.carryFrom + i * EP05.carryEvery + EP05.carryDuration;

test("episode 5's timeline is sound", () => {
  assert.deepEqual(timelineProblems(EP05_BEATS, EP05_LINES, EP05_SECONDS), []);
  assert.ok(EP05_SECONDS >= 33 && EP05_SECONDS <= 42);
});

test("the hook's words and swarm are on screen from the first frames", () => {
  assert.ok(EP05.hookWordsAt <= 0.2 && EP05.swarmFrom <= 0.1);
  assert.ok(EP05.swarmBuilt <= spoken("h1")[1] + 0.3);
});

test("the stage opens between the hook and the meet line, and nothing lands during it", () => {
  assert.ok(EP05.stageFrom >= spoken("h1")[1]);
  assert.ok(EP05.stageTo <= spoken("m1")[0] + 0.2);
  assert.ok(EP05.avatarAt >= EP05.stageTo);
});

test("the request is typed while it is said", () => {
  const [start, end] = spoken("w1");
  const typedBy = EP05.requestFrom + EP05_REQUEST.length / EP05.requestCps;
  assert.ok(EP05.requestFrom >= start - 0.3 && typedBy <= end + 0.6);
});

test("the posts land while their making is described, before '3 ready'", () => {
  const [start] = spoken("w2");
  RISE_POSTS.forEach((_, i) => {
    assert.ok(landsAt(i) >= start, `post ${i} lands too early`);
    assert.ok(landsAt(i) + 0.3 <= EP05.readyAt);
  });
});

test("the times appear while 'the best times to post' is said", () => {
  const [start, end] = spoken("w3");
  assert.ok(EP05.timesAt >= start - 0.2 && EP05.timesAt <= end);
});

test("the Approve click lands on 'say yes'", () => {
  const [start, end] = spoken("y1");
  assert.ok(EP05.click >= start && EP05.click <= end + 0.2);
  assert.ok(EP05.scheduledAt > EP05.click);
});

test("the end card shows the address while it is said, captioned as written", () => {
  const [start, end] = spoken("e2");
  assert.ok(EP05.urlAt >= start - 0.3 && EP05.urlAt <= end);
  assert.ok(EP05.closeFrom >= EP05.scheduledAt + 0.6);
  const e2 = EP05_LINES.find((l) => l.id === "e2");
  assert.equal(e2?.caption, "Early access is open at colony.global.");
});

test("captions never cover the posts card", () => {
  assert.ok(POSTS_CARD.y + POSTS_CARD.h <= 940);
});
```

- [ ] **Step 2:** Run `node --test src/explainers/ep05.test.ts`; expect FAIL (module missing).
- [ ] **Step 3:** Write `ep05.ts` from the measured cuts: hook line at 0.3 s; meet line right after the stage opens; work lines back to back with 0.25 s gaps; yes; end. Set every `EP05` time against the line it serves, per the tests.
- [ ] **Step 4:** Run the test until PASS (adjust times, never the tests). Commit `video(explainers): episode 5 timeline`.

### Task 5: Bakery posts and the posts card

**Files:**
- Create: `video/src/explainers/RisePosts.tsx` (three posts, 264 px squares), `video/src/explainers/RisePostsCard.tsx` (card, carriers, cursor)
- Reuse: `postSlot`, `postCarryPath`, `POST_SIZE`, `POSTS_CARD` from `src/launch/wide/posts.ts`; `WorkerAnt`; `TONES.pink`

**Interfaces:**
- Consumes: `EP05` (Task 4), `RISE`, `RISE_COLORS`, `RISE_POSTS` (Task 1).
- Produces: `RisePostArt({ id })`, `RisePostsCard({ t })`, `RisePostCarriers({ t })`, `ApproveCursor({ t })`.

- [ ] **Step 1:** Draw the three posts in the chosen bakery style (Task 1 references): `sourdough` (cream, illustrated loaf with score lines, serif "Fresh sourdough", "Out of the oven at 7"), `market` (poster: "Find us at the Saturday market", day and hours, stall awning stripes), `croissant` (warm butter colour, croissant illustration, "Warm croissants from 7"). Each carries the Rise mark and handle.
- [ ] **Step 2:** Card: "Posts." title; under it "You asked:" and the request typed live at `EP05.requestCps` from `EP05.requestFrom`; three slots with dashed outlines until each post lands; carriers as in the launch film; the times (`RISE_POSTS[i].when`) rise under each post from `EP05.timesAt`; a pink "Approve and schedule" button appears at `EP05.readyAt` in the chip's place; the cursor travels from `EP05.cursorFrom` and clicks at `EP05.click`; at `EP05.scheduledAt` the button becomes "3 posts scheduled" with a tick and each post gets a small tick badge.
- [ ] **Step 3:** Render stills (`npx remotion still src/index.ts Explainer05 out.png --frame=N --timeout=120000`) mid-carry, after ready, after click; look at each; fix overlaps (captions must not cover the card; card bottom above y 940).
- [ ] **Step 4:** Commit `video(explainers): Rise Bakery posts and the posts card`.

### Task 6: Hook, shell and composition

**Files:**
- Create: `video/src/explainers/HookScene.tsx` (hook words + croissant swarm), `video/src/explainers/useShapeSwarm.ts` (ants from the frame edges into a drawn shape), `video/src/explainers/ExplainerShell.tsx`, `video/src/explainers/Explainer05.tsx`
- Modify: `video/src/launch/wide/CloseScene.tsx` (add `plain?: boolean`: no drop shadow, glow only pulses), `video/src/Root.tsx` (register `Explainer05`), `video/package.json` (`render:ex05`, `master:ex05`)
- Test: `video/src/explainers/swarmShape.test.ts` for the pure edge-start and timing helper

**Interfaces:**
- Consumes: everything above; `LightWorld`, `BrightStage`, `EmployeeHero` with `LOOKS.pink`, `Subtitles`, `CornerLogo`, `CloseScene`, `Grain`, `musicVolume`, `createAnts`, `antState`, `drawAnt`, `sampleAlphaPoints`, `pickPoints`.
- Produces: `Explainer05` composition, 1920 by 1080, 30 fps, `EP05_SECONDS * 30` frames.

- [ ] **Step 1: Write the failing test** for `edgeStarts(n, rand, frame)` (points just outside the frame on all four sides) and `swarmBuiltBy(ants)` (latest landing time).

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mulberry32 } from "../launch/math.ts";
import { edgeStarts } from "./swarmShape.ts";

test("swarm ants start just outside the frame, on every side", () => {
  const pts = edgeStarts(400, mulberry32(7), { w: 1920, h: 1080 });
  assert.equal(pts.length, 400);
  for (const p of pts) {
    const outside = p.x < 0 || p.x > 1920 || p.y < 0 || p.y > 1080;
    assert.ok(outside, `(${p.x}, ${p.y}) is inside the frame`);
    assert.ok(p.x > -160 && p.x < 2080 && p.y > -160 && p.y < 1240);
  }
  const sides = new Set(pts.map((p) => (p.x < 0 ? "l" : p.x > 1920 ? "r" : p.y < 0 ? "t" : "b")));
  assert.equal(sides.size, 4);
});
```

- [ ] **Step 2:** Run; expect FAIL. Implement `swarmShape.ts`; run; expect PASS.
- [ ] **Step 3:** Hook: hook words left of centre in Inter 800 (~120 px) "When did you last post?" from `EP05.hookWordsAt`, "Be honest." from `EP05.hookHonestAt`; on the right, ~500 ink ants fly in from the edges and build a croissant silhouette (drawn on a canvas with Path2D, sampled with `sampleAlphaPoints`) by `EP05.swarmBuilt`; at `EP05.stageFrom` the ants turn pink and fade as the bright stage fades in.
- [ ] **Step 4:** Shell: LightWorld (warm palettes), hook, BrightStage reveal `stageFrom..stageTo` and close `closeFrom..closeDark`, EmployeeHero pink with `focusFrom`, the posts card, CloseScene `plain`, CornerLogo, Subtitles (pink highlights; captions off for e1 and e2 since the end card shows them), Grain, voice lines, music (draft B cut to lift on the meet and on the end card), sfx (pop per post landing and on "3 ready", scribble while typing, click on Approve, whoosh on stage moves).
- [ ] **Step 5:** Register `Explainer05` and the scripts; `npx tsc --noEmit -p .`; `npx biome check src`; full test suite.
- [ ] **Step 6:** Commit `video(explainers): episode 5 composition`.

### Task 7: Render, gates, delivery

**Files:**
- Modify: `video/package.json` scripts (done in Task 6)

- [ ] **Step 1:** `pnpm render:ex05 && pnpm master:ex05` (background; `--timeout=120000`).
- [ ] **Step 2:** Gates: `ebur128` integrated -16 plus or minus 1 LUFS and true peak at most -1 dBFS; darkest frame `YAVG` above 150 at 2 fps; frames at the hook, mid-carry and the end card render byte-identical twice; the 16 kHz voice track transcribes in script order; a 16-frame contact sheet looked at frame by frame.
- [ ] **Step 3:** Publish a new watch page "Colony Explainers" with a 16:9 player for episode 5 and a what changed / checked / not checked list; open it. Copy the master to `~/Desktop/Colony video tests/21 explainer 05 - makes your posts (bakery pilot).mp4`.
- [ ] **Step 4:** Push `claude/colony-explainers-s1`; ledger line in `.superpowers/sdd/2026-10-11-colony-explainer-05-bakery-pilot/progress.md`.
