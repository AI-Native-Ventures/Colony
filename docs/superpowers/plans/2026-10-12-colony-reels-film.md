# Colony Reels Launch Film Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This run: native inline (the owner does not use subagents).

**Goal:** A 1080 x 1920 version of the 1:59 launch film for Instagram Reels, with the same voice, music, sound and timing, every scene laid out again for a phone held upright.

**Architecture:** A new tall composition `Film90Tall` in `video/src/launch/tall/` reuses the wide film's timeline, cards, ants and audio. The film's cards (drawn in 1920 x 1080 panel pixels, at x 860, y 150) are placed into the tall frame by one CSS transform; the employee row, the opening's positions, the captions, the scroll between scenes and the day scene get tall versions. The wide film stays byte-identical: every film change is an option with the film's value as its default, checked by rendering film frames before and after.

**Tech Stack:** Remotion 4.0.522, React 19, TypeScript, Node's test runner (`node --test`), ffmpeg for the gates.

**Spec:** `docs/superpowers/specs/2026-10-12-colony-reels-launch-film-design.html` (published: https://claude.ai/artifact/KMXr4FgLDWbPm1GmjSxjV9)

## Global Constraints

- Frame 1080 x 1920 at 30 fps; length 119 s, the wide film's `FILM90_SECONDS`.
- Same audio as the wide film: same voice files, music cues, ducking and sound effects at the same times.
- Instagram covers: top 250 px, bottom 400 px, and the right edge from x 948 between y 1050 and y 1520. No text inside them.
- The feed shows the middle 4:5 band, y 285 to y 1635: the employee row and the card sit inside it.
- Cards at 94% of their film size: 940 x 760 becomes 883.6 x 714.4, placed at x 58, y 650.
- Captions: 46 px, two rows at most, left of the like and comment buttons (x 58 to x 940), from y 1392.
- No shrinking of text below the film's own sizes except the 94% card scale; no cropping of scenes.
- The wide film `Film90` stays byte-identical: rendered frames before and after each film change must hash the same.
- No em dashes anywhere (copy check in `video/src/launch/copy-scan.test.ts` covers `src/launch`).
- Commits with `git commit -s`; the branch is `claude/colony-reels-film`; PR into develop at the end; push only as nocodeafrica with an explicit refspec.

## Review Focus

1. A long caption line (Scout's 21 words) must never grow past two rows or into the bottom cover: pinned by the chunking test in Task 4.
2. A one-line employee title wider than the frame ("Keeps your site fresh.") must shrink to fit, never wrap or overflow: pinned by the fit test in Task 4.
3. The scroll between scenes must land exactly on the next scene and never move outside a pan: pinned by the scroll test in Task 5.
4. The ants of the opening swarm must start from the tall tower and end on the tall logo: pinned by the opening layout test in Task 3 (logo and tower inside the frame, lanes out of view).
5. The tall film's audio must equal the wide film's: pinned by the audio comparison in Task 5's gates.

---

## Pilot (the owner watches this before the rest is built)

### Task 1: The tall frame

**Files:**
- Create: `video/src/launch/tall/frame.ts`
- Test: `video/src/launch/tall/frame.test.ts`
- Modify: `video/package.json` (test script picks up `src/launch/tall/*.test.ts`)

**Interfaces:**
- Produces: `TALL_W = 1080`, `TALL_H = 1920`, `COVERED`, `FEED_BAND`, `type Box = { x; y; w; h }`, `HERO_BOX`, `CARD_SCALE = 0.94`, `CARD_BOX`, `CAPTION_BOX`, `PANEL_CARD = { x: 860, y: 150 }`, `toTall(p) -> { x, y }`, `PANEL_TRANSFORM: string`, `clearOfCovers(b: Box) -> boolean`, `insideFeed(b: Box) -> boolean`.

- [ ] **Step 1: Write the failing test** (`frame.test.ts`)

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAPTION_BOX, CARD_BOX, clearOfCovers, COVERED, HERO_BOX,
  insideFeed, PANEL_CARD, TALL_H, TALL_W, toTall,
} from "./frame.ts";

test("the employee row, the card and the captions stay clear of Instagram's covers", () => {
  for (const b of [HERO_BOX, CARD_BOX, CAPTION_BOX]) assert.ok(clearOfCovers(b), JSON.stringify(b));
});

test("the employee row and the card sit inside the feed's 4:5 band", () => {
  assert.ok(insideFeed(HERO_BOX) && insideFeed(CARD_BOX));
});

test("a film card's corners land on the tall card box", () => {
  const a = toTall(PANEL_CARD);
  const b = toTall({ x: PANEL_CARD.x + 940, y: PANEL_CARD.y + 760 });
  assert.deepEqual(a, { x: CARD_BOX.x, y: CARD_BOX.y });
  assert.ok(Math.abs(b.x - (CARD_BOX.x + CARD_BOX.w)) < 1e-9);
  assert.ok(Math.abs(b.y - (CARD_BOX.y + CARD_BOX.h)) < 1e-9);
});

test("the boxes stack top to bottom without touching", () => {
  assert.ok(HERO_BOX.y + HERO_BOX.h <= CARD_BOX.y);
  assert.ok(CARD_BOX.y + CARD_BOX.h + 20 <= CAPTION_BOX.y);
  assert.ok(CAPTION_BOX.y + CAPTION_BOX.h <= TALL_H - COVERED.bottom);
  assert.ok(CARD_BOX.x + CARD_BOX.w <= TALL_W);
});
```

- [ ] **Step 2: Run it, expect FAIL** (`node --test src/launch/tall/frame.test.ts` → ERR_MODULE_NOT_FOUND).

- [ ] **Step 3: Implement `frame.ts`**

```ts
export const TALL_W = 1080;
export const TALL_H = 1920;
export type Box = { x: number; y: number; w: number; h: number };

/** What Instagram draws over a Reel (third-party guides, 2026): keep text out. */
export const COVERED = { top: 250, bottom: 400, right: { x: 948, from: 1050, to: 1520 } } as const;
/** What the feed shows before a tap: the middle 4:5 band. */
export const FEED_BAND = { top: 285, bottom: 1635 } as const;

export const CARD_SCALE = 0.94;
/** Where the film's 940 x 760 cards land. */
export const CARD_BOX: Box = { x: 58, y: 650, w: 940 * CARD_SCALE, h: 760 * CARD_SCALE };
/** The employee row, its one-line title and its subline. */
export const HERO_BOX: Box = { x: 58, y: 296, w: 964, h: 344 };
/** Captions: two rows at most, left of the like and comment buttons. */
export const CAPTION_BOX: Box = { x: 58, y: 1392, w: 882, h: 120 };

/** The film's card origin, in its 1920 x 1080 panel pixels. */
export const PANEL_CARD = { x: 860, y: 150 } as const;

/** A point in the film's panel pixels, in the tall frame. */
export function toTall(p: { x: number; y: number }): { x: number; y: number } {
  return { x: CARD_BOX.x + (p.x - PANEL_CARD.x) * CARD_SCALE, y: CARD_BOX.y + (p.y - PANEL_CARD.y) * CARD_SCALE };
}

/** The CSS transform (origin 0 0) that puts a film panel's card layer where `toTall` says. */
export const PANEL_TRANSFORM = `translate(${CARD_BOX.x - PANEL_CARD.x * CARD_SCALE}px, ${CARD_BOX.y - PANEL_CARD.y * CARD_SCALE}px) scale(${CARD_SCALE})`;

export function clearOfCovers(b: Box): boolean {
  const inFrame = b.x >= 0 && b.x + b.w <= TALL_W && b.y >= COVERED.top && b.y + b.h <= TALL_H - COVERED.bottom;
  const r = COVERED.right;
  const hitsRight = b.x + b.w > r.x && b.y < r.to && b.y + b.h > r.from;
  return inFrame && !hitsRight;
}

export function insideFeed(b: Box): boolean {
  return b.y >= FEED_BAND.top && b.y + b.h <= FEED_BAND.bottom;
}
```

- [ ] **Step 4: Run it, expect PASS (4/4).** Add `src/launch/tall/*.test.ts` to the `test` script in `video/package.json`.
- [ ] **Step 5: Commit** `video(reels): the tall frame and Instagram's covered areas`.

### Task 2: Film sound and captions as shared pieces

**Files:**
- Create: `video/src/launch/wide/FilmSound.tsx` (every `<Sequence><Audio/>` the wide film plays, as one component)
- Create: `video/src/launch/wide/film90Captions.ts` (`SHOWN_LINES`, `KEYWORDS`, `HIGHLIGHTS`, moved out of `LaunchFilm90.tsx`)
- Modify: `video/src/launch/wide/LaunchFilm90.tsx` (uses both; nothing else changes)

**Interfaces:**
- Produces: `FilmSound: React.FC` (no props; reads `useVideoConfig().fps`), `SHOWN_LINES: Line90[]`, `KEYWORDS: Record<string, ReadonlySet<string>>`, `HIGHLIGHTS: Record<string, Highlight>`.

- [ ] **Step 1: Baseline** before the move: render Film90 frames 300, 540, 840, 1080, 1320 and the film's audio for 0 to 48 s (`remotion render ... --frames=0-1439 --codec=wav`, then `ffmpeg -i x.wav -f s16le - | shasum`), saving hashes in the scratchpad.
- [ ] **Step 2: Move** `MUSIC_CUES`, `DUCK`, `WINDOWS`, `POPS`, `PRESSES`, `SOFT_POPS`, `WHOOSHES` and the audio JSX into `FilmSound.tsx`, and the caption sets into `film90Captions.ts`; `LaunchFilm90.tsx` renders `<FilmSound />` and imports the caption sets.
- [ ] **Step 3: Gate**: the same frames and the same audio render byte-identical (hash equal). Full suite green.
- [ ] **Step 4: Commit** `video(launch): film sound and captions as shared pieces, film unchanged`.

### Task 3: The opening takes a layout

**Files:**
- Modify: `video/src/launch/wide/intro.ts` (add `OpeningLayout` and `WIDE_OPENING`)
- Modify: `video/src/launch/wide/WideOpening.tsx`, `towerDraw.ts`, `useWideAnts.ts` (take a layout; default `WIDE_OPENING`)
- Modify: `video/src/launch/wide/MeshGradient.tsx` (`LightWorld` takes `width`, `height`; defaults wide)
- Modify: `video/src/launch/wide/CornerLogo.tsx` (takes `x`, `y`; defaults 60, 42)
- Create: `video/src/launch/tall/opening.ts` (`TALL_OPENING`)
- Test: `video/src/launch/tall/opening.test.ts`

**Interfaces:**
- Produces:

```ts
export type OpeningLayout = {
  w: number; h: number;
  trade: { top: number; size: number };
  tower: { centerY: number; maxWidth: number };
  logo: { cx: number; cy: number; width: number; height: number };
  /** How far the logo glides up when the definition takes over. */
  logoShift: number;
  define: { top: number; width: number };
  team: { y: number; gap: number };
  lanes: Lane[];
};
export const WIDE_OPENING: OpeningLayout; // the film's current numbers
// tall/opening.ts
export const TALL_OPENING: OpeningLayout;
// WideOpening: ({ t, ants, layout = WIDE_OPENING })
// drawTower(ctx, family, t, mode, layout = WIDE_OPENING)
// useOpeningAnts(layout): Ant[] | null   (useWideAnts keeps returning { opening, close } for the film)
```

`TALL_OPENING` (1080 x 1920): `trade: { top: 860, size: 128 }`, `tower: { centerY: 960, maxWidth: 940 }`, `logo: { cx: 540, cy: 760, width: 380, height: 380 * 309 / 466 }`, `logoShift: -230`, `define: { top: 760, width: 900 }`, `team: { y: 1320, gap: 120 }`, lanes out past the left and right edges and back into the logo from above (tuned on stills).

- [ ] **Step 1: Write the failing test** (`opening.test.ts`): the trade word, the tower (centre plus or minus half its estimated height, nine words at their sizes times the 0.94 leading), the logo, the name block under the logo (logo bottom plus 40 px plus 292 px), the definition (top plus 112 plus 26 plus three rows of 62 px) and the team row (y plus or minus 42) all lie between y 250 and y 1520 and inside x 0 to 1080; each lane's outward control point lies outside the frame.
- [ ] **Step 2: Run it, expect FAIL.**
- [ ] **Step 3: Implement** the layout type, `WIDE_OPENING` from today's constants (`WIDE_LOGO_RECT`, `TOWER_STACK.centerY`, `TOWER_MAX_WIDTH`, trade top `WIDE_H / 2 - 100` and size 168, definition top 400 and width 1100, team y 860 and gap 130, `WIDE_LANES`, logo shift -200), thread it through the opening's components, the tower drawing and the swarm sampling, and add `TALL_OPENING`.
- [ ] **Step 4: Run it, expect PASS.**
- [ ] **Step 5: Gate**: Film90 frames 60, 285, 360, 465, 540, 690, 840, 930 byte-identical to frames rendered before the change. Full suite green.
- [ ] **Step 6: Commit** `video(launch): the opening takes a layout; tall opening layout`.

### Task 4: Tall employee row and tall captions

**Files:**
- Create: `video/src/launch/tall/TallHero.tsx`, `video/src/launch/tall/captions.ts`, `video/src/launch/tall/TallCaptions.tsx`
- Test: `video/src/launch/tall/captions.test.ts`, `video/src/launch/tall/hero.test.ts`

**Interfaces:**
- Produces: `TallHero: React.FC<{ t: number; look: HeroLook; timing: HeroTiming }>` (avatar 96 px at x 58, y 296; badge beside it; the title on one line, 92 px fitted down to 964 px wide by measuring; the subline at 30 px, two rows at most, by y 640; the same pop, ring and word-in motion and the same focus softening as `EmployeeHero`); `heroTitle(look) -> string` (the two title parts joined with a space); `captionChunks(text: string, rowChars: number) -> { from: number; to: number }[]` (word index ranges, two rows each); `TallCaptions: React.FC<{ t; lines; keywords; highlights; until? }>` (the chunk holding the word being said, words still to come kept invisible so nothing shifts).

- [ ] **Step 1: Write the failing tests**: every film caption (`SHOWN_LINES`) splits into chunks of at most two rows of at most 28 characters, covering every word once in order; Scout's 21-word line gives at least two chunks; `heroTitle` of every look the film uses is non-empty and has no line break.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `captions.ts` (greedy rows at word boundaries, two rows per chunk), `TallCaptions.tsx` (46 px Inter 700, box from `CAPTION_BOX`, keywords marked as the film marks them, a chunk shows while its words are said and the line's last chunk holds until the line's `until`), and `TallHero.tsx`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `video(reels): tall employee row and two-row captions`.

### Task 5: Film90Tall, pilot range

**Files:**
- Create: `video/src/launch/tall/scroll.ts`, `video/src/launch/tall/TallBlooms.tsx`, `video/src/launch/tall/Film90Tall.tsx`
- Test: `video/src/launch/tall/scroll.test.ts`
- Modify: `video/src/Root.tsx` (register `Film90Tall`, 1080 x 1920, `FILM90_SECONDS`), `video/package.json` (`render:tall:pilot` frames 0 to 1409, `master:tall:pilot`, `render:tall`, `master:tall`)

**Interfaces:**
- Consumes: Tasks 1 to 4, `PANS`, `PANEL_ORDER`, `INTRO`, `CLOSE90`, the film's cards.
- Produces: `panelY(id) -> number` (index times 1920), `scrollY(t) -> number` (the film's pans, in y), `Film90Tall: React.FC`.

- [ ] **Step 1: Write the failing test** (`scroll.test.ts`): `scrollY` is 0 before the first pan, equals `panelY(pan.to)` from each pan's end until the next pan's start, and is constant outside pans.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `scroll.ts`, `TallBlooms.tsx` (the panel's tone blooms placed for a tall page), and `Film90Tall.tsx`: the light world at 1080 x 1920, `WideOpening` with `TALL_OPENING` and its own swarm, the bright stage (fade), a vertical strip of tall pages (for the pilot: `how` and `scout`; each page holds `TallHero` and the film's card components inside a div with `PANEL_TRANSFORM`, origin 0 0), a vertical glide blur while scrolling, `CornerLogo` at x 58, y 262, `TallCaptions`, grain, `FilmSound`.
- [ ] **Step 4: Run, expect PASS**; typecheck and lint clean.
- [ ] **Step 5: Stills** at 2, 9, 12.5, 15.5, 18, 23, 28, 33, 36, 38, 41, 44, 46.5 s; fix overlaps and anything that crosses a covered area.
- [ ] **Step 6: Gates**: render 0 to 47 s, master to -16 LUFS; true peak at most -1 dBFS; darkest frame above 150; three frames identical twice; the tall audio equals the wide film's audio over the same range (PCM hash); 16-frame sheet; Film90 frames still byte-identical.
- [ ] **Step 7: Deliver**: a watch page with the pilot in a phone-shaped player, the Desktop copy as the next number, commit, push.
- [ ] **GATE: the owner watches the pilot.** Stop here until he says how it looks.

## After the pilot (owner approved the pilot on 2026-10-12: "Looks right, build the rest")

### Task 6: The team scenes and the rivers

**Files:**
- Modify: `video/src/launch/wide/River.tsx` (`offsetY`, `width`, `height` props; defaults keep the film: 0, 1920, 1080)
- Create: `video/src/launch/tall/rivers.ts` (`TALL_RIVERS: Record<EmployeeId, RiverSpec>`, `TALL_BURSTS: RiverSpec[]`), `video/src/launch/tall/rivers.test.ts`
- Modify: `video/src/launch/tall/Film90Tall.tsx` (pages `blue`, `amber`, `pink`, `green`, `yes`; rivers and bursts drawn with `offsetY = scrollY(t)`)

**Interfaces:**
- Consumes: `RiverSpec`, `RIVERS90` timings (`TIMING90[id].riverFrom`, `avatarAt`), `YES_ROWS`, `yesRowY`, `approvedAt`, `YES90`, `employeeNode`, `HERO.avatar`, `toTall`, `panelY`.
- Produces: `TALL_RIVERS`, `TALL_BURSTS`; pages use `TallHero` plus the film's card components inside `Cards`.

- [ ] **Step 1: Failing test** (`rivers.test.ts`): every team river starts on the page before its employee's and lands on that employee's avatar (`panelY(id) + HERO.avatar`); it starts and lands at the film's times (`riverFrom`, `avatarAt`); every burst starts on an inbox row of the `yes` page and ends past the right edge (x > 1080).
- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement** the river props, `rivers.ts` (blue leaves from Scout's blue task row on the plan card, the others from the middle of the previous scene's card, each curving down to its avatar; bursts leave each inbox row to the right), and the five pages: `LeadsBoard` and `Carriers` (blue, no camera zoom), `EmailCard`, `PenAnt` and `CallCard` (amber), `PostsGrid` and `PostCarriers` (pink), `WebsiteCard` and `Painter` (green), `InboxCard`, `InboxCarriers` and `InboxCursor` (`OWNER` hero, yes).
- [ ] **Step 4: Run, PASS**; typecheck, lint.
- [ ] **Step 5: Gate**: Film90 frames 1430, 1700, 2100, 2280 and 2710 (rivers and bursts) byte-identical to frames rendered before the River change.
- [ ] **Step 6: Stills** at every beat (50, 53, 55, 59, 63, 67, 72, 74, 79, 82, 86, 90, 93 s); re-route any ant path that crosses an employee row or a caption; commit.

### Task 7: The day, running down the screen

**Files:**
- Create: `video/src/launch/tall/day.ts` (layout), `video/src/launch/tall/TallDay.tsx`, `video/src/launch/tall/day.test.ts`
- Modify: `video/src/launch/tall/Film90Tall.tsx` (page `day`)

**Interfaces:**
- Produces: `TALL_DAY = { clock: { x, y }, ruler: { x, top, bottom }, you: { x, w }, team: { x, w }, summary: { y } }`, `hourY(h) -> number`, `chipTops(chips) -> number[]` (each chip's top: at its hour, pushed down so no two overlap), `tallDayAntSpot(k, hour) -> Point`.

- [ ] **Step 1: Failing test** (`day.test.ts`): the clock, the ruler, both columns and the summary lie between y 250 and y 1520 and clear of the right buttons; `hourY` runs down from 07:00 to 18:00; chip boxes never overlap and none ends below 18:00; each chip shows no later than 0.2 hours after its time; the "You" blocks fit their column.
- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement** `day.ts` and `TallDay.tsx`: the clock (136 px) and "Tuesday" on top; hours down the left (odd hours labelled); "You" blocks growing down as the clock runs; "Your team" chips popping at their times, stacked without overlap; the now line across both columns with the four ants walking down under it; the sun glow following the time; the "Today" summary as a 2 by 2 grid under 18:00. Same times as `DayPanel` (`DAY90`, `TEAM_CHIPS`, `YOU_BLOCKS`).
- [ ] **Step 4: Run, PASS**; stills at 97, 100, 103, 106, 108 s; commit.

### Task 8: The end card, the full film and the PR

**Files:**
- Modify: `video/src/launch/wide/CloseScene.tsx` (a `layout` prop: frame size and logo; default the film's), `video/src/launch/wide/closeSwarm.ts` (starts, lanes and frame width as arguments; defaults the film's)
- Create: `video/src/launch/tall/close.ts` (`TALL_CLOSE`, tall close lanes), `video/src/launch/tall/close.test.ts`, `useTallCloseAnts` in `tall/`
- Modify: `video/src/launch/tall/Film90Tall.tsx` (`CloseScene` with the tall layout and swarm)

- [ ] **Step 1: Failing test** (`close.test.ts`): the logo, the name, the tagline, "Early access is open" and the address pill lie between y 250 and y 1520; every close lane flies from the day's ant spots into the logo.
- [ ] **Step 2: Run, FAIL.** **Step 3: Implement.** **Step 4: Run, PASS.**
- [ ] **Step 5: Gate**: Film90 frames 3300, 3420 and 3540 byte-identical to frames rendered before the change.
- [ ] **Step 6: Full render** (119 s) with the Task 5 gates over the whole film (loudness, peak, darkest frame, three frames twice, the tall audio equal to the wide film's over all 119 s, a 16-frame sheet).
- [ ] **Step 7: Deliver**: the watch page with the full film, the Desktop copy, the execution record in this plan, one PR into develop with auto-merge armed, bound to the session.
