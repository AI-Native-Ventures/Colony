# Colony Reels Explainers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upright (1080 x 1920) versions of the 8 Colony explainers for Instagram Reels, same voice, music and timing as the wide ones, starting with one pilot episode (5, Rise Bakery, "Makes your posts") that the owner watches before the other seven are built.

**Architecture:** A tall shell, `TallShell`, mirrors `ExplainerShell` with the Reels film's pieces: the hook on a tall layout (words on top, the trade's tool built by ants below), `TallHero` for the employee row, the episode's own work scene drawn in its wide panel pixels inside the film's `Cards` transform, the plain end card on `TALL_CLOSE`, and `TallCaptions` with each line's caption end. The sound moves into a shared `ExplainerSound` so both shells play the same mix. Every change to a shared piece is an optional prop whose default is the wide value, proven by byte-identical frames and audio.

**Tech Stack:** Remotion 4.0.522 (standalone `video/` package), React 19, TypeScript, `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-12-colony-reels-launch-film-design.html` (the tall frame, Instagram's covered areas, the card scale, the caption rules). The owner chose on 2026-10-12: "same frame as film, one pilot episode first, you watch it before the other 7".

## Global Constraints

- Frame 1080 x 1920 at 30 fps. Covered by Instagram: top 250, bottom 400, the button column x >= 948 for y 1050 to 1520. Feed 4:5 crop: y 285 to 1635.
- Each tall episode's audio PCM equals its wide episode's.
- The wide explainers and the launch film stay byte-identical (frames and audio).
- Loudness -16 LUFS within 1 LU, true peak at most -1 dBFS, no dark frames, deterministic frames.
- No em dashes anywhere; the explainers' copy rules (`copy.test.ts`) hold.

## Review Focus

1. A hook line wider than the frame ("An AI that emails", "The best clients") must shrink to fit on one line, never wrap or clip: pinned by the hook fit test in Task 2.
2. The ant-built tool must sit fully in view, below the words and above the captions: pinned by the hook layout test in Task 2.
3. The hook swarm must come in from off the frame: pinned by the hook layout test in Task 2.
4. Episodes whose wide work scene uses the left column (the hand-off in 3, the owner's line in 6) need their own tall placements: checked per episode after the pilot.
5. Each tall episode's audio must equal its wide episode's: pinned by the audio gate in Task 3 and in each later episode.

---

## Pilot

### Task 1: Explainer sound as a shared piece

**Files:**
- Create: `video/src/explainers/ExplainerSound.tsx`
- Modify: `video/src/explainers/ExplainerShell.tsx` (renders `<ExplainerSound config={config} />` in place of its audio sequences, same order)

**Interfaces:**
- Produces: `ExplainerSound: React.FC<{ config: ShellConfig }>`: music cues with the duck, whooshes, pops, scribbles, clicks, extras and voice lines, exactly as `ExplainerShell` plays them today.

- [ ] **Step 1: Baseline**: render the audio of all 8 wide explainers (`--codec=wav`) and Explainer05 frames 0, 405 and 840 from the current code; keep PCM hashes and PNG hashes.
- [ ] **Step 2: Implement** `ExplainerSound` by moving the sequences, in the same order, out of `ExplainerShell`.
- [ ] **Step 3: Gate**: all 8 audio PCM hashes and the 3 frames are byte-identical; suite, typecheck and lint clean. Commit.

### Task 2: The hook takes a layout

**Files:**
- Modify: `video/src/explainers/HookScene.tsx` (a `layout` prop: frame size, where the words sit and their largest size, the subline size, where the tool is built, the swarm's lane; default `WIDE_HOOK`, today's values)
- Create: `video/src/explainers/hookLayout.ts` (`HookLayout`, `WIDE_HOOK`), `video/src/launch/tall/hook.ts` (`TALL_HOOK`, `hookWordSize(lines, layout)`), `video/src/launch/tall/hook.test.ts`

**Interfaces:**
- Produces: `type HookLayout = { w: number; h: number; words: { x: number; top: number; size: number; width: number }; subline: number; shape: { cx: number; cy: number }; lane: Lane; sides: readonly Side[] }`; `WIDE_HOOK`; `TALL_HOOK`; `hookWordSize(lines: readonly [string, string], layout: HookLayout): number` (the largest size at most `words.size` at which both lines fit `words.width`, estimated at 0.56 em a character; the scene measures the real width).

- [ ] **Step 1: Failing test** (`hook.test.ts`): for every episode's hook lines, `hookWordSize` fits both lines in 964 px and never exceeds 116; the words block (two lines at that size plus the subline) and every tool (`HOOK_SHAPE_WIDTH`, its height at most its width) at `TALL_HOOK.shape` lie inside the visible frame, clear of the button column and of the caption box, and do not overlap each other; the lane's bends lie off the words.
- [ ] **Step 2: Run, FAIL.** **Step 3: Implement** the layout prop and `TALL_HOOK` (words at x 58 from y 300, the tool centred at x 540 under them). **Step 4: Run, PASS.**
- [ ] **Step 5: Gate**: each wide explainer's hook frames (0 and the frame its tool is built) are byte-identical before and after. Commit.

### Task 3: TallShell and the pilot episode

**Files:**
- Create: `video/src/explainers/TallShell.tsx`, `video/src/explainers/Explainer05Tall.tsx`
- Modify: `video/src/Root.tsx` (`Explainer05Tall`, 1080 x 1920, `EP05_SECONDS`), `video/package.json` (`render:ex05:tall`, `master:ex05:tall`)

**Interfaces:**
- Consumes: `ShellConfig`, `ExplainerSound`, `HookScene` with `TALL_HOOK`, `TallHero`, `Cards` (exported from `Film90Tall.tsx` into `video/src/launch/tall/Cards.tsx`), `CloseScene` with `TALL_CLOSE` and no ants, `TallCaptions`, `captionUntil`.
- Produces: `TallShell: React.FC<{ config: ShellConfig; children: (t: number) => React.ReactNode }>`, children drawn in wide panel pixels.

- [ ] **Step 1: Implement** `Cards.tsx` (moved out of `Film90Tall.tsx`, unchanged), `TallShell`, `Explainer05Tall`, the Root entry and scripts. No corner mark (as the film).
- [ ] **Step 2: Stills** at the hook, the stage opening, the meet, every work beat, the yes and the end card; fix anything off the frame or under the captions.
- [ ] **Step 3: Full render and gates**: 1080 x 1920; loudness, true peak, darkest frame; three frames twice; the tall audio PCM equals the wide Explainer05's; the Reels film frames 1500 and 3300 unchanged; a 16-frame sheet.
- [ ] **Step 4: Deliver**: a watch page with the pilot, a Desktop copy, the ledger. **GATE: the owner watches the pilot.**

## After the pilot (written step by step once the owner has seen it)

- Tasks 4 to 10: one per remaining episode (1, 2, 3, 4, 6, 7, 8). Each: a `ExplainerNNTall` on `TallShell`; stills at every beat; tall placements where the wide work scene used the left column (the hand-off in 3, the owner's line card in 6), each as an optional prop with the wide default and a frame gate; full render with the pilot's gates.
- Task 11: all 8 on one watch page, Desktop copies, one PR into develop.
