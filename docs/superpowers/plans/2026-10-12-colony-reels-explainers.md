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

## Pilot v2 (owner's notes on the pilot, 2026-10-12)

The owner watched the pilot: "the illustrations can be more mobile like vertical instead of horizontal ... so it fits well" and "the captions are only on a small part of the screen". Asked how far to go, the owner chose "Whole card = phone screen": each card redrawn as a tall phone-style screen filling the middle of the frame, the employee shrinking to a slim header once the card arrives, the posts big and stacked one under the other, the captions about 1.6x bigger. Episode 5 is redone first; the other seven follow the same way. The launch film keeps the look the owner approved.

### Task 4: Bigger captions and a slim header (shared)

**Files:** Modify `video/src/launch/tall/captions.ts` (`CaptionStyle`, `FILM_CAPTIONS` = the film's 46 px in `CAPTION_BOX`, 26 a row; `BIG_CAPTIONS` = 74 px in x 132 to 948, y 1322 to 1512, 20 a row), `TallCaptions.tsx` (a `look` prop, default `FILM_CAPTIONS`), `hero.ts` (`SLIM`: avatar 56 px at x 140, the title at 46 px beside it, y 296 to 356), `TallHero.tsx` (an optional `compactAt`: from then the avatar shrinks, the title slides up beside it and shrinks, the badge and the subline fade). Tests: the big caption box and the slim header are clear of the covers and inside the feed crop; every explainer line chunks into rows of at most 20 characters and never leaves a lone word. Gate: Film90Tall frames unchanged.

### Task 5: The phone card and episode 5's feed

**Files:** Create `video/src/explainers/phone.ts` (`PHONE_CARD`: x 140, y 376, 800 x 924, under the slim header and above the big captions), `PhoneCard.tsx` (the frame: white, rounded, enters like the film's cards), `ep05Phone.ts` (the feed: posts 460 px square, each with its time under it, 564 px apart; the scroll down as the posts arrive and back up as the times appear; the carriers' paths from below the card; the sticky Approve button and the pointer), `ep05Phone.test.ts`, `RisePostsPhone.tsx`; modify `TallShell.tsx` (children in tall pixels, `compactAt`, big captions) and `Explainer05Tall.tsx`.

Tests: the card is clear of the covers, the slim header and the captions; each post's slot is fully in view when its ant lands; each time chip is in view when it pops; the feed never scrolls past the first or the last post; the Approve button sits inside the card and the pointer ends on it.

Gate: stills at every beat; full render with the pilot's gates; audio equal to the wide episode 5; the owner watches pilot v2.

## The other seven (owner approved pilot v2, 2026-10-12: "Looks right, do other 7")

Shared first (Task 6): `phoneKit.tsx` with the pieces every phone screen uses: the screen title, the status pill, "You asked" with the typed request, the Approve button pinned to the card's foot (and the pointer onto it), and a push from one screen to the next (the first slides out left, the second in from the right, like a phone app). `APPROVE` and the pointer keys move from `ep05Phone.ts` into `phone.ts`; episode 5 stays byte-identical.

Then one task per episode, each with its own geometry module and tests (what must be in view when the voice names it, the scroll range, the pointer ending on its button), its phone component, stills at every beat, and the full render with the pilot's gates (audio equal to the wide episode's, the wide episode and the film unchanged):

- Task 7, episode 8 (chats): the chat list (Weddings, Office lunches, Website, each lit as it is named), a tap into Weddings, the thread with Scout's menu, your reply typed on it, the new menu coming back, Approve under it.
- Task 8, episode 7 (your yes): the "To review" list filling, a tap into the quote reply, your note typed under it, the reply rewritten shorter, Approve pinned, then "Sent" with the paper plane.
- Task 9, episode 1 (Scout): "This month's plan.", the request typed, the four jobs dealt as big rows one under the other, each checked, "Approve plan" pinned.
- Task 10, episode 2 (your team): "Your business." with the website pasted and read, the facts as big rows, then a push to "Your team." with the four employees and Scout, "Hire my team" pinned.
- Task 11, episode 4 (sales): a phone email being written by the pen ant, sent, the reply as a banner, a push to the call screen (timer, the two lines spoken, "Meeting booked"), then the next step card with Approve pinned.
- Task 12, episode 3 (customers): the leads as big rows (company, why it fits, tick box), twenty found, your picks ticked; the slim header hands over to the sales employee and a push to "Emails to your 5 picks" with the picks flying in and the pointer resting on Approve.
- Task 13, episode 6 (website): Mo's Auto Repairs redrawn as a mobile page, the request typed on top, the painter repainting it top to bottom, Before and After in the bar, Approve, then "Live".
- Task 14: all eight on the watch page, Desktop copies, one PR into develop.
